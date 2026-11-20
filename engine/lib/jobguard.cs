// NORN-WATCH S5 (DEC-683): the Windows half of "a run's process tree dies with the run" (jobguard.mjs). Compiled on first use with
// the csc.exe of .NET Framework 4 (in every Windows 10 / 11), cached by source hash. Three verbs:
//   hold <pid> <name>        create the named Job Object <name> (KILL_ON_JOB_CLOSE | BREAKAWAY_OK), put <pid> (the run's supervisor)
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
//                            kill every process of the job but <keep-pid>, then clear KILL_ON_JOB_CLOSE (what the supervisor starts
//                            after its end - tick, auto-resume - lives on). DEC-1088: each pid of the job's list is opened and its
//                            HANDLE re-checked as a member (IsProcessInJob): a member that exited between the list and the open may
//                            name a reused pid, a stranger - skipped, never killed. Each one gets a receipt line appended to
//                            <receipts> (kills.mjs; JSON: at, killer, reason, action kill | skipped, pid, image, cmd, ppid, job) BEFORE
//                            its kill: a receipt not written = "err", no kill. Prints "killed <pid> <image>" / "skipped <pid> <image>"
//                            lines, then "reaped <n>". The optional pid list joins the job's list (the test seam of a non-member pid).
//   procs                    every process, one JSON line { pid, ppid, name, cmd } (kills.mjs receipts: no PowerShell start per kill).
//   spawn <cwd> <cmdline>    start <cmdline> outside the caller's job (CREATE_BREAKAWAY_FROM_JOB, detached, no window); prints
//                            "pid <n> breakaway", or "pid <n> inside" when an outer job forbids breakaway.
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
    Limits(job, KILL_ON_CLOSE | BREAKAWAY_OK);
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

  static int Spawn(string cwd, string cmdline) {
    const uint BREAKAWAY = 0x01000000, DETACHED = 0x8, NEW_GROUP = 0x200, NO_WINDOW = 0x08000000;
    foreach (bool away in new[] { true, false }) {
      var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); PI pi;
      uint f = DETACHED | NEW_GROUP | NO_WINDOW | (away ? BREAKAWAY : 0);
      if (CreateProcess(null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero, false, f, IntPtr.Zero, cwd, ref si, out pi)) {
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        Console.Out.WriteLine("pid " + pi.pid + (away ? " breakaway" : " inside")); return 0;
      }
      int err = Marshal.GetLastWin32Error();
      if (!away || err != 5) throw new Win32Exception(err);   // 5 = access denied: an outer job forbids breakaway -> start inside
    }
    return 1;
  }

  static int Main(string[] a) {
    try {
      if (a.Length == 3 && a[0] == "hold") return Hold(int.Parse(a[1]), a[2]);
      if ((a.Length == 6 || a.Length == 7) && a[0] == "reap") return Reap(a[1], int.Parse(a[2]), a[3], a[4], a[5], a.Length == 7 ? a[6] : "");
      if (a.Length == 1 && a[0] == "procs") return Procs();
      if (a.Length == 3 && a[0] == "spawn") return Spawn(a[1], a[2]);
      Console.Out.WriteLine("err usage: jobguard hold <pid> <name> | reap <name> <keep-pid> <receipts> <killer> <reason> [<pid,pid>] | procs | spawn <cwd> <cmdline>"); return 2;
    } catch (Exception e) { Console.Out.WriteLine("err " + e.Message); return 1; }
  }
}
