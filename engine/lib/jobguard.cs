// NORN-WATCH S5 (DEC-683): the Windows half of "a run's process tree dies with the run" (jobguard.mjs). Compiled on first use with
// the csc.exe of .NET Framework 4 (in every Windows 10 / 11), cached by source hash. Five verbs:
//   hold <pid> <name>        create the named Job Object <name> (KILL_ON_JOB_CLOSE, no BREAKAWAY_OK), put <pid> (the run's supervisor)
//                            in it, print "ok", then wait for stdin EOF or the exit of <pid> itself, whichever comes first (the
//                            supervisor ended or died) and exit: the handle closes, and while KILL_ON_JOB_CLOSE is still set the job
//                            kills everything in it. The process wait: the hold ends with its supervisor however the pipe behaves
//                            (a hold seen alive after its supervisor = ci-suite LEAK RED, CI 44141688462 / 43996467416).
//                            CI 44343850063 (queue, a stop right after the start): the supervisor died while its hold started.
//                            Then stdin EOF and the process exit come at once, and two threads in Environment.Exit can hang the
//                            CLR shutdown; and the pid may already name another process (Windows reuses pids). So the hold ends
//                            by TerminateProcess on itself (no CLR shutdown, safe from both threads), and refuses ("err") a <pid>
//                            that has exited or was created after the hold itself (not its supervisor: a reused pid).
//   reap <name> <keep-pid> <receipts> <killer> <reason> [<pid,pid>]
//                            kill every process of the job but <keep-pid>, then clear KILL_ON_JOB_CLOSE and allow breakaway (what the
//                            supervisor starts after its end - tick, auto-resume - lives on). DEC-1088: each pid of the job's list is opened and its
//                            HANDLE re-checked as a member (IsProcessInJob): a member that exited between the list and the open may
//                            name a reused pid, a stranger - skipped, never killed. Each one gets a receipt line appended to
//                            <receipts> (kills.mjs; JSON: at, killer, reason, action kill | skipped, pid, image, cmd, ppid, job) BEFORE
//                            its kill: a receipt not written = "err", no kill. Prints "killed <pid> <image>" / "skipped <pid> <image>"
//                            lines, then "reaped <n>". The optional pid list joins the job's list (the test seam of a non-member pid).
//   procs                    every process, one JSON line { pid, ppid, name, cmd } (kills.mjs receipts: no PowerShell start per kill).
//   spawn <job|-> <cwd> <cmdline>  start <cmdline> outside the caller's job (CREATE_BREAKAWAY_FROM_JOB, detached, no window); prints
//                            "pid <n> breakaway", or "pid <n> inside" when an outer job forbids breakaway. <job> (the run's named job)
//                            allows breakaway only around this one CreateProcess and forbids it again at once.
//   run <ms> <cwd> <cmdline> run <cmdline> in a new KILL_ON_JOB_CLOSE job of its own (this helper enters it first, so the child and
//                            all it starts are in it from birth, suspended or not); exit with the child's code and kill the whole job
//                            at the child's exit, at <ms> (exit 124, "jobguard-timeout" on stderr) or when this helper is killed (its
//                            handle closes). A CreateProcess failure: "jobguard-err <message>" on stderr, exit 127. stdio passes through.
// proc-hygiene (2026-11-19, 84 orphaned tail.exe / grep.exe watchers): with BREAKAWAY_OK set, Git Bash (MSYS2 / Cygwin) starts every
// child with CREATE_BREAKAWAY_FROM_JOB, so a worker's 'tail -f | grep' left the run's job at birth and outlived the reap. The job
// never allows breakaway while the run lives, except inside 'spawn'.
// Any failure prints "err <message>" (exit 1).
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

static class JobGuard {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IOC Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public int cb; public string r, d, t; public int x, y, w, h, cx, cy, fill, flags; public short show, r2; public IntPtr r3, i, o, e; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr hProcess, hThread; public int pid, tid; }
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenJobObject(int access, bool inh, string n);
  [DllImport("kernel32", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, int n);
  [DllImport("kernel32", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr j, int c, IntPtr i, int n, IntPtr r);
  [DllImport("kernel32", SetLastError = true)] static extern IntPtr OpenProcess(int a, bool inh, int pid);
  [DllImport("kernel32", SetLastError = true)] static extern bool TerminateProcess(IntPtr p, uint code);
  [DllImport("kernel32", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr j, int c, ref EXT i, int n, IntPtr r);
  [DllImport("kernel32", SetLastError = true)] static extern bool TerminateJobObject(IntPtr j, uint code);
  [DllImport("kernel32", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
  [DllImport("kernel32", SetLastError = true)] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32", SetLastError = true)] static extern bool GetProcessTimes(IntPtr p, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32", SetLastError = true)] static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr p, int f, StringBuilder s, ref int n);
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr exit, peb, affinity, prio, pid, ppid; }
  [DllImport("ntdll")] static extern int NtQueryInformationProcess(IntPtr p, int c, ref PBI b, int n, out int r);
  [DllImport("ntdll")] static extern int NtQueryInformationProcess(IntPtr p, int c, IntPtr b, int n, out int r);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PE32 { public uint size, usage, pid; public IntPtr heap; public uint module, threads, ppid; public int prio; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe; }
  [DllImport("kernel32", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint f, uint pid);
  [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr s, ref PE32 e);
  [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr s, ref PE32 e);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PI pi);
  const uint KILL_ON_CLOSE = 0x2000, BREAKAWAY_OK = 0x800;
  const int EXTENDED = 9, PID_LIST = 3, JOB_ALL = 0x1F001F, SET_QUOTA = 0x0100, TERMINATE = 0x0001, SYNCHRONIZE = 0x00100000, QUERY_LIMITED = 0x1000;

  static void Limits(IntPtr job, uint flags) {
    var e = new EXT(); e.Basic.LimitFlags = flags;
    if (!SetInformationJobObject(job, EXTENDED, ref e, Marshal.SizeOf(typeof(EXT)))) throw new Win32Exception();
  }
  static List<int> Pids(IntPtr job) {
    int n = 4096, size = 8 + n * IntPtr.Size;
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      if (!QueryInformationJobObject(job, PID_LIST, buf, size, IntPtr.Zero)) throw new Win32Exception();
      int count = Marshal.ReadInt32(buf, 4); var r = new List<int>();
      for (int k = 0; k < count; k++) r.Add((int)Marshal.ReadIntPtr(buf, 8 + k * IntPtr.Size));
      return r;
    } finally { Marshal.FreeHGlobal(buf); }
  }

  static int Hold(int pid, string name) {
    IntPtr job = CreateJobObject(IntPtr.Zero, name);
    if (job == IntPtr.Zero) throw new Win32Exception();
    Limits(job, KILL_ON_CLOSE);
    IntPtr p = OpenProcess(SET_QUOTA | TERMINATE | SYNCHRONIZE | QUERY_LIMITED, false, pid);
    if (p == IntPtr.Zero) throw new Win32Exception();
    long born, self, x, k, u;
    if (!GetProcessTimes(p, out born, out x, out k, out u) || !GetProcessTimes(GetCurrentProcess(), out self, out x, out k, out u)) throw new Win32Exception();
    if (born > self) throw new Exception("pid " + pid + " was created after this hold: not its supervisor (a reused pid)");
    if (WaitForSingleObject(p, 0) == 0) throw new Exception("pid " + pid + " has exited");
    if (!AssignProcessToJobObject(job, p)) throw new Win32Exception();
    Console.Out.WriteLine("ok"); Console.Out.Flush();
    var reader = new System.Threading.Thread(() => { while (Console.In.ReadLine() != null) { } End(); });
    reader.IsBackground = true; reader.Start();
    WaitForSingleObject(p, 0xFFFFFFFF);   // the held process exited
    End();
    return 0;
  }
  // EOF or the held process gone: the kernel closes the job handle with this process. No Environment.Exit: two threads in it at once
  // (EOF and the exit together, a supervisor that died) can hang the CLR shutdown, and the reader thread may sit in a read.
  static void End() { TerminateProcess(GetCurrentProcess(), 0); }

  // what a receipt names, read from the opened handle itself (the process the kill would hit, not a pid looked up again)
  static string Image(IntPtr h) { var b = new StringBuilder(1024); int n = b.Capacity; return QueryFullProcessImageName(h, 0, b, ref n) ? System.IO.Path.GetFileName(b.ToString(0, n)) : ""; }
  static int Ppid(IntPtr h) { var b = new PBI(); int r; return NtQueryInformationProcess(h, 0, ref b, Marshal.SizeOf(typeof(PBI)), out r) == 0 ? (int)b.ppid : 0; }
  static string Cmd(IntPtr h) {   // ProcessCommandLineInformation (60, Windows 8.1+): a UNICODE_STRING followed by its text
    int need; NtQueryInformationProcess(h, 60, IntPtr.Zero, 0, out need);
    if (need <= 0) return "";
    IntPtr buf = Marshal.AllocHGlobal(need);
    try { int r; if (NtQueryInformationProcess(h, 60, buf, need, out r) != 0) return ""; int len = (ushort)Marshal.ReadInt16(buf, 0); IntPtr s = Marshal.ReadIntPtr(buf, IntPtr.Size); return s == IntPtr.Zero ? "" : Marshal.PtrToStringUni(s, len / 2); }
    finally { Marshal.FreeHGlobal(buf); }
  }
  static string Js(string s) {
    var b = new StringBuilder("\"");
    foreach (char ch in s ?? "") { if (ch == '"' || ch == '\\') b.Append('\\').Append(ch); else if (ch < 0x20 || char.IsSurrogate(ch)) b.AppendFormat("\\u{0:x4}", (int)ch); else b.Append(ch); }
    return b.Append('"').ToString();
  }
  static string Cut(string s) { return s.Length > 300 ? s.Substring(0, 300) : s; }

  static int Reap(string name, int keep, string receipts, string killer, string reason, string also) {
    IntPtr job = OpenJobObject(JOB_ALL, false, name);
    if (job == IntPtr.Zero) throw new Win32Exception();
    var seen = new HashSet<string>(); int self = System.Diagnostics.Process.GetCurrentProcess().Id, n = 0;
    var extra = new List<int>(); foreach (string p in also.Split(',')) if (p != "") extra.Add(int.Parse(p));
    var utf8 = new UTF8Encoding(false);
    for (int pass = 0; pass < 3; pass++) {   // a process may be born while we kill: three passes
      var list = Pids(job); if (pass == 0) list.AddRange(extra);
      foreach (int x in list) {
        if (x == keep || x == self) continue;   // this reap process runs inside the job too
        IntPtr h = OpenProcess(TERMINATE | QUERY_LIMITED, false, x);
        if (h == IntPtr.Zero) continue;   // gone meanwhile
        try {
          long born, ex, k, u; GetProcessTimes(h, out born, out ex, out k, out u);
          if (!seen.Add(x + ":" + born)) continue;   // handled in an earlier pass (a killed member is listed until it is gone)
          bool member; if (!IsProcessInJob(h, job, out member)) member = false;
          string image = Image(h), line = "{\"at\":" + Js(DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")) + ",\"killer\":" + Js(killer) + ",\"reason\":" + Js(reason)
            + ",\"action\":" + Js(member ? "kill" : "skipped") + (member ? "" : ",\"why\":\"not in the job (left it, or a reused pid)\"") + ",\"pid\":" + x + ",\"image\":" + Js(image)
            + ",\"cmd\":" + Js(Cut(Cmd(h))) + ",\"ppid\":" + Ppid(h) + ",\"job\":" + Js(name) + "}\n";
          System.IO.File.AppendAllText(receipts, line, utf8);   // throws = "err": no receipt, no kill
          if (!member) { Console.Out.WriteLine("skipped " + x + " " + image); continue; }
          if (TerminateProcess(h, 1)) { n++; Console.Out.WriteLine("killed " + x + " " + image); }
        } finally { CloseHandle(h); }
      }
    }
    // the run's tree is gone: what the supervisor starts after its end may break away again. 'spawn' cannot open the window then:
    // the hold has ended, and with its handle the job's name (CI 44672523595 dod.test: the Done resume started "inside" the
    // supervisor's libuv kill-on-close job and died with the supervisor's exit)
    Limits(job, BREAKAWAY_OK);
    CloseHandle(job);
    Console.Out.WriteLine("reaped " + n);
    return 0;
  }

  static int Procs() {
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);   // TH32CS_SNAPPROCESS
    if (snap == new IntPtr(-1)) throw new Win32Exception();
    var o = new StringBuilder(); var e = new PE32(); e.size = (uint)Marshal.SizeOf(typeof(PE32));
    for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e)) {
      string cmd = ""; IntPtr h = OpenProcess(QUERY_LIMITED, false, (int)e.pid);
      if (h != IntPtr.Zero) { cmd = Cmd(h); CloseHandle(h); }
      o.Append("{\"pid\":" + e.pid + ",\"ppid\":" + e.ppid + ",\"name\":" + Js(e.exe) + ",\"cmd\":" + Js(cmd) + "}\n");
    }
    CloseHandle(snap);
    Console.Out.Write(o.ToString());
    return 0;
  }

  static uint Flags(IntPtr job) {
    var e = new EXT();
    if (!QueryInformationJobObject(job, EXTENDED, ref e, Marshal.SizeOf(typeof(EXT)), IntPtr.Zero)) throw new Win32Exception();
    return e.Basic.LimitFlags;
  }
  // breakaway is allowed only around this CreateProcess. Two spawns at once: either may close the window on the other, whose
  // CreateProcess then fails with 5 - it reopens the window and tries again. The window always ends closed, never restored "open".
  static int Spawn(string jobName, string cwd, string cmdline) {
    const uint BREAKAWAY = 0x01000000, DETACHED = 0x8, NEW_GROUP = 0x200, NO_WINDOW = 0x08000000;
    IntPtr job = jobName == "-" ? IntPtr.Zero : OpenJobObject(JOB_ALL, false, jobName);
    try {
      for (int tries = 0; tries < 6; tries++) {
        bool away = tries < 5;
        if (away && job != IntPtr.Zero) Limits(job, Flags(job) | BREAKAWAY_OK);
        var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); PI pi;
        uint f = DETACHED | NEW_GROUP | NO_WINDOW | (away ? BREAKAWAY : 0);
        bool ok = CreateProcess(null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero, false, f, IntPtr.Zero, cwd, ref si, out pi);
        int err = ok ? 0 : Marshal.GetLastWin32Error();
        if (job != IntPtr.Zero) Limits(job, Flags(job) & ~BREAKAWAY_OK);
        if (ok) {
          CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
          Console.Out.WriteLine("pid " + pi.pid + (away ? " breakaway" : " inside")); return 0;
        }
        if (!away || err != 5) throw new Win32Exception(err);   // 5 = access denied: breakaway forbidden (an outer job, a racing spawn)
        if (job == IntPtr.Zero) tries = 4;   // no window of ours to reopen: start inside next
      }
      return 1;
    } finally { if (job != IntPtr.Zero) CloseHandle(job); }
  }

  static int Run(uint ms, string cwd, string cmdline) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    Limits(job, KILL_ON_CLOSE);
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
    var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.flags = 0x100;   // STARTF_USESTDHANDLES
    si.i = GetStdHandle(-10); si.o = GetStdHandle(-11); si.e = GetStdHandle(-12);
    PI pi;
    if (!CreateProcess(null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, cwd == "-" ? null : cwd, ref si, out pi)) {
      Console.Error.WriteLine("jobguard-err " + new Win32Exception(Marshal.GetLastWin32Error()).Message); Console.Error.Flush(); return 127;
    }
    CloseHandle(pi.hThread);
    if (WaitForSingleObject(pi.hProcess, ms) != 0) {
      Console.Error.WriteLine("jobguard-timeout " + ms + " ms"); Console.Error.Flush();
      TerminateJobObject(job, 124);   // the child, everything it started (suspended or not), and this helper
      return 124;
    }
    uint code; GetExitCodeProcess(pi.hProcess, out code);
    return (int)code;   // the job handle closes with this process: KILL_ON_JOB_CLOSE ends whatever the child left behind
  }

  static int Main(string[] a) {
    try {
      if (a.Length == 3 && a[0] == "hold") return Hold(int.Parse(a[1]), a[2]);
      if ((a.Length == 6 || a.Length == 7) && a[0] == "reap") return Reap(a[1], int.Parse(a[2]), a[3], a[4], a[5], a.Length == 7 ? a[6] : "");
      if (a.Length == 1 && a[0] == "procs") return Procs();
      if (a.Length == 4 && a[0] == "spawn") return Spawn(a[1], a[2], a[3]);
      if (a.Length == 4 && a[0] == "run") return Run(uint.Parse(a[1]), a[2], a[3]);
      Console.Out.WriteLine("err usage: jobguard hold <pid> <name> | reap <name> <keep-pid> <receipts> <killer> <reason> [<pid,pid>] | procs | spawn <job|-> <cwd> <cmdline> | run <ms> <cwd> <cmdline>"); return 2;
    } catch (Exception e) { Console.Out.WriteLine("err " + e.Message); return 1; }
  }
}
