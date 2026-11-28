// norn-jobguard (RM-26 S6B Q1): the `run <ms> <cwd> <cmdline>` verb of engine/lib/jobguard.cs with its exact contract, native: bounded.mjs
// boundedSync / boundedAsync run their child through it on Windows when it is built (rustbin.mjs part jobguard; ~17 ms less per bounded
// git than the C# helper, measured). `version` answers { crate, store_schema, source } as every part does (NORN-PART-PROOF). The child starts SUSPENDED, joins a
// new KILL_ON_JOB_CLOSE job, then resumes: it and all it starts are in the job from birth. stdio is inherited. Exit = the child's code;
// at <ms> "jobguard-timeout <ms> ms" on stderr, the job terminated, exit 124; a start failure "jobguard-err <message>", exit 127.
// The job handle closes with this process, so whatever the child left behind dies at its exit or with this helper.
#[cfg(windows)]
mod k32 {
    // the few kernel32 calls and structs this needs, declared by hand (std only: no windows-sys dependency)
    use std::ffi::c_void;
    pub type Handle = *mut c_void;
    #[repr(C)] pub struct StartupInfoW { pub cb: u32, pub reserved: *mut u16, pub desktop: *mut u16, pub title: *mut u16, pub x: u32, pub y: u32, pub xs: u32, pub ys: u32,
        pub xc: u32, pub yc: u32, pub fill: u32, pub flags: u32, pub show: u16, pub cb2: u16, pub r2: *mut u8, pub stdin: Handle, pub stdout: Handle, pub stderr: Handle }
    #[repr(C)] pub struct ProcessInformation { pub process: Handle, pub thread: Handle, pub pid: u32, pub tid: u32 }
    #[repr(C)] pub struct Basic { pub proc_time: i64, pub job_time: i64, pub flags: u32, pub min_ws: usize, pub max_ws: usize, pub procs: u32, pub affinity: usize, pub prio: u32, pub sched: u32 }
    #[repr(C)] pub struct Extended { pub basic: Basic, pub io: [u64; 6], pub proc_mem: usize, pub job_mem: usize, pub peak_proc: usize, pub peak_job: usize }
    pub const KILL_ON_JOB_CLOSE: u32 = 0x2000; pub const EXTENDED_INFO: i32 = 9; pub const SUSPENDED: u32 = 0x4; pub const USESTDHANDLES: u32 = 0x100;
    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateJobObjectW(attrs: *const c_void, name: *const u16) -> Handle;
        pub fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, len: u32) -> i32;
        pub fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        pub fn TerminateJobObject(job: Handle, code: u32) -> i32;
        pub fn GetStdHandle(n: u32) -> Handle;
        pub fn CreateProcessW(app: *const u16, cmd: *mut u16, pa: *const c_void, ta: *const c_void, inherit: i32, flags: u32, env: *const c_void,
            cwd: *const u16, si: *const StartupInfoW, pi: *mut ProcessInformation) -> i32;
        pub fn TerminateProcess(process: Handle, code: u32) -> i32;
        pub fn ResumeThread(thread: Handle) -> u32;
        pub fn CloseHandle(h: Handle) -> i32;
        pub fn WaitForSingleObject(h: Handle, ms: u32) -> u32;
        pub fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
        pub fn GetLastError() -> u32;
    }
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("version") {
        println!("{{\"crate\":\"{}\",\"store_schema\":null,\"source\":\"{}\"}}", env!("CARGO_PKG_VERSION"), env!("NORN_SOURCE"));
        return;
    }
    run()
}

#[cfg(windows)]
fn run() {
    use k32::*;
    use std::io::Write;
    use std::os::windows::ffi::OsStrExt;

    let a: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let ms: Option<u32> = a.get(1).and_then(|s| s.to_str()).and_then(|s| s.parse().ok());
    let (ms, cwd, cmd) = match (a.len(), a.first().and_then(|s| s.to_str()), ms) {
        (4, Some("run"), Some(ms)) => (ms, &a[2], &a[3]),
        _ => { println!("err usage: norn-jobguard run <ms> <cwd> <cmdline>"); std::process::exit(2) }
    };
    let err = |what: &str, code: u32| -> ! {
        let _ = writeln!(std::io::stderr(), "jobguard-err {what}: {}", std::io::Error::from_raw_os_error(code as i32));
        std::process::exit(127)
    };
    let wide = |s: &std::ffi::OsStr| s.encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let mut cmdw = wide(cmd);
    let cwdw = if cwd == "-" { None } else { Some(wide(cwd)) };
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() { err("CreateJobObject", GetLastError()) }
        let mut lim: Extended = std::mem::zeroed();
        lim.basic.flags = KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(job, EXTENDED_INFO, &lim as *const _ as *const _, std::mem::size_of::<Extended>() as u32) == 0 {
            err("SetInformationJobObject", GetLastError())
        }
        let mut si: StartupInfoW = std::mem::zeroed();
        si.cb = std::mem::size_of::<StartupInfoW>() as u32;
        si.flags = USESTDHANDLES;
        (si.stdin, si.stdout, si.stderr) = (GetStdHandle(-10i32 as u32), GetStdHandle(-11i32 as u32), GetStdHandle(-12i32 as u32));
        let mut pi: ProcessInformation = std::mem::zeroed();
        if CreateProcessW(std::ptr::null(), cmdw.as_mut_ptr(), std::ptr::null(), std::ptr::null(), 1, SUSPENDED, std::ptr::null(),
            cwdw.as_ref().map_or(std::ptr::null(), |w| w.as_ptr()), &si, &mut pi) == 0 {
            err("CreateProcess", GetLastError())
        }
        if AssignProcessToJobObject(job, pi.process) == 0 {
            let e = GetLastError();
            TerminateProcess(pi.process, 127);   // never leave it suspended and unguarded
            err("AssignProcessToJobObject", e)
        }
        ResumeThread(pi.thread);
        CloseHandle(pi.thread);
        if WaitForSingleObject(pi.process, ms) != 0 {
            let _ = writeln!(std::io::stderr(), "jobguard-timeout {ms} ms");
            TerminateJobObject(job, 124);   // the child and everything it started
            std::process::exit(124)
        }
        let mut code = 0u32;
        GetExitCodeProcess(pi.process, &mut code);
        std::process::exit(code as i32)   // the job handle closes with this process: KILL_ON_JOB_CLOSE ends what the child left
    }
}

#[cfg(not(windows))]
fn run() { eprintln!("jobguard-err norn-jobguard runs on Windows only"); std::process::exit(127) }
