// NORN-WATCH S5 (DEC-683): the Windows half of "a run's process tree dies with the run" (jobguard.mjs). Compiled on first use with
// the csc.exe of .NET Framework 4 (in every Windows 10 / 11), cached by source hash. Four verbs:
//   hold <pid> <name>        create the named Job Object <name> (KILL_ON_JOB_CLOSE, no BREAKAWAY_OK), put <pid> (the run's supervisor)
//                            in it, print "ok", then wait for stdin EOF or the exit of <pid> itself, whichever comes first (the
//                            supervisor ended or died) and exit: the handle closes, and while KILL_ON_JOB_CLOSE is still set the job
//                            kills everything in it. The process wait: the hold ends with its supervisor however the pipe behaves
//                            (a hold seen alive after its supervisor = ci-suite LEAK RED, CI 44141688462 / 43996467416).
//   reap <name> <keep-pid>   kill every process of the job but <keep-pid>, then clear KILL_ON_JOB_CLOSE (what the supervisor starts
//                            after its end - tick, auto-resume - lives on); prints "reaped <n> <pid:name,pid:name>".
//   spawn <job|-> <cwd> <cmdline>  start <cmdline> outside the caller's job (CREATE_BREAKAWAY_FROM_JOB, detached, no window); prints
//                            "pid <n> breakaway", or "pid <n> inside" when an outer job forbids breakaway. <job> (the run's named job)
//                            allows breakaway only around this one CreateProcess and forbids it again at once.
//   run <ms> <cwd> <cmdline> run <cmdline> in a new KILL_ON_JOB_CLOSE job of its own (this helper enters it first, so the child and
//                            all it starts are in it from birth, suspended or not); exit with the child's code and kill the whole job
//                            at the child's exit, at <ms> (exit 124, "jobguard-timeout" on stderr) or when this helper is killed (its
//                            handle closes). A CreateProcess failure: "jobguard-err <message>" on stderr, exit 127. stdio passes through.
// proc-hygiene (2026-11-19, 84 orphaned tail.exe / grep.exe watchers): with BREAKAWAY_OK set, Git Bash (MSYS2 / Cygwin) starts every
// child with CREATE_BREAKAWAY_FROM_JOB, so a worker's 'tail -f | grep' left the run's job at birth and outlived the reap. The job
// never allows breakaway except inside 'spawn'.
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
  [DllImport("kernel32")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PI pi);
  const uint KILL_ON_CLOSE = 0x2000, BREAKAWAY_OK = 0x800;
  const int EXTENDED = 9, PID_LIST = 3, JOB_ALL = 0x1F001F, SET_QUOTA = 0x0100, TERMINATE = 0x0001, SYNCHRONIZE = 0x00100000;

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
    IntPtr p = OpenProcess(SET_QUOTA | TERMINATE | SYNCHRONIZE, false, pid);
    if (p == IntPtr.Zero || !AssignProcessToJobObject(job, p)) throw new Win32Exception();
    Console.Out.WriteLine("ok"); Console.Out.Flush();
    var reader = new System.Threading.Thread(() => { while (Console.In.ReadLine() != null) { } Environment.Exit(0); });
    reader.IsBackground = true; reader.Start();
    WaitForSingleObject(p, 0xFFFFFFFF);   // the held process exited
    Environment.Exit(0);   // EOF or the held process gone: the handles close with this process (Exit: the reader thread may sit in a read)
    return 0;
  }

  static int Reap(string name, int keep) {
    IntPtr job = OpenJobObject(JOB_ALL, false, name);
    if (job == IntPtr.Zero) throw new Win32Exception();
    var killed = new List<string>(); int self = System.Diagnostics.Process.GetCurrentProcess().Id;
    for (int pass = 0; pass < 3; pass++) {   // a process may be born while we kill: three passes
      foreach (int x in Pids(job)) {
        if (x == keep || x == self) continue;   // this reap process runs inside the job too
        IntPtr h = OpenProcess(TERMINATE, false, x);
        if (h == IntPtr.Zero) continue;
        string nm = "?"; try { nm = System.Diagnostics.Process.GetProcessById(x).ProcessName + ".exe"; } catch { }
        string tag = x + ":" + nm.Replace(",", "_").Replace(" ", "_");
        if (TerminateProcess(h, 1) && !killed.Exists(k => k.StartsWith(x + ":"))) killed.Add(tag);
        CloseHandle(h);
      }
    }
    Limits(job, 0);
    CloseHandle(job);
    Console.Out.WriteLine("reaped " + killed.Count + " " + string.Join(",", killed.ToArray()));
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
      if (a.Length == 3 && a[0] == "reap") return Reap(a[1], int.Parse(a[2]));
      if (a.Length == 4 && a[0] == "spawn") return Spawn(a[1], a[2], a[3]);
      if (a.Length == 4 && a[0] == "run") return Run(uint.Parse(a[1]), a[2], a[3]);
      Console.Out.WriteLine("err usage: jobguard hold <pid> <name> | reap <name> <keep-pid> | spawn <job|-> <cwd> <cmdline> | run <ms> <cwd> <cmdline>"); return 2;
    } catch (Exception e) { Console.Out.WriteLine("err " + e.Message); return 1; }
  }
}
