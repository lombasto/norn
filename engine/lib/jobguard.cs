// NORN-WATCH S5 (DEC-683): the Windows half of "a run's process tree dies with the run" (jobguard.mjs). Compiled on first use with
// the csc.exe of .NET Framework 4 (in every Windows 10 / 11), cached by source hash. Three verbs:
//   hold <pid> <name>        create the named Job Object <name> (KILL_ON_JOB_CLOSE | BREAKAWAY_OK), put <pid> (the run's supervisor)
//                            in it, print "ok", then wait for stdin EOF or the exit of <pid> itself, whichever comes first (the
//                            supervisor ended or died) and exit: the handle closes, and while KILL_ON_JOB_CLOSE is still set the job
//                            kills everything in it. The process wait: the hold ends with its supervisor however the pipe behaves
//                            (a hold seen alive after its supervisor = ci-suite LEAK RED, CI 44141688462 / 43996467416). A supervisor
//                            already gone at start = exit at once.
//   reap <name> <keep-pid>   kill every process of the job but <keep-pid>, then clear KILL_ON_JOB_CLOSE (what the supervisor starts
//                            after its end - tick, auto-resume - lives on); prints "reaped <n> <pid,pid>".
//   spawn <cwd> <cmdline>    start <cmdline> outside the caller's job (CREATE_BREAKAWAY_FROM_JOB, detached, no window); prints
//                            "pid <n> breakaway", or "pid <n> inside" when an outer job forbids breakaway.
// Any failure prints "err <message>" (exit 1).
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

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
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PI pi);
  const uint KILL_ON_CLOSE = 0x2000, BREAKAWAY_OK = 0x800;
  const int EXTENDED = 9, PID_LIST = 3, JOB_ALL = 0x1F001F, SET_QUOTA = 0x0100, TERMINATE = 0x0001, SYNCHRONIZE = 0x00100000;
  const uint INFINITE = 0xFFFFFFFF, WAIT_OBJECT_0 = 0;

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
    IntPtr p = OpenProcess(SET_QUOTA | TERMINATE | SYNCHRONIZE, false, pid);   // a pid already gone: no handle -> err, exit at once
    if (p == IntPtr.Zero || !AssignProcessToJobObject(job, p)) throw new Win32Exception();
    if (WaitForSingleObject(p, 0) == WAIT_OBJECT_0) return 0;   // the supervisor ended before the wait began
    Console.Out.WriteLine("ok"); Console.Out.Flush();
    // CI-RED-7D65D2D (DEC-383): stdin EOF alone let a hold outlive its supervisor while any process still held the write end. Exit
    // on whichever fires first: stdin EOF (reader thread) or the supervisor's process handle signalled (it exited).
    var eof = new Thread(() => { while (Console.In.ReadLine() != null) { } Environment.Exit(0); });
    eof.IsBackground = true; eof.Start();
    WaitForSingleObject(p, INFINITE);   // the held process exited
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
        if (TerminateProcess(h, 1) && !killed.Contains(x.ToString())) killed.Add(x.ToString());
        CloseHandle(h);
      }
    }
    Limits(job, BREAKAWAY_OK);
    CloseHandle(job);
    Console.Out.WriteLine("reaped " + killed.Count + " " + string.Join(",", killed.ToArray()));
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
      if (a.Length == 3 && a[0] == "reap") return Reap(a[1], int.Parse(a[2]));
      if (a.Length == 3 && a[0] == "spawn") return Spawn(a[1], a[2]);
      Console.Out.WriteLine("err usage: jobguard hold <pid> <name> | reap <name> <keep-pid> | spawn <cwd> <cmdline>"); return 2;
    } catch (Exception e) { Console.Out.WriteLine("err " + e.Message); return 1; }
  }
}
