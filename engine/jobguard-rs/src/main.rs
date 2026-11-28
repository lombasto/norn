// jobguard (Rust prototype, RM-26 S6B Q1): the `run <ms> <cwd> <cmdline>` verb of engine/lib/jobguard.cs with its exact contract,
// to measure whether a native helper saves start time per bounded git (bounded.mjs boundedSync). The child starts SUSPENDED, joins a
// new KILL_ON_JOB_CLOSE job, then resumes: it and all it starts are in the job from birth. stdio is inherited. Exit = the child's code;
// at <ms> "jobguard-timeout <ms> ms" on stderr, the job terminated, exit 124; a start failure "jobguard-err <message>", exit 127.
// The job handle closes with this process, so whatever the child left behind dies at its exit or with this helper.
#[cfg(windows)]
fn main() {
    use std::io::Write;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Threading::*;

    let a: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let ms: Option<u32> = a.get(1).and_then(|s| s.to_str()).and_then(|s| s.parse().ok());
    let (ms, cwd, cmd) = match (a.len(), a.first().and_then(|s| s.to_str()), ms) {
        (4, Some("run"), Some(ms)) => (ms, &a[2], &a[3]),
        _ => { println!("err usage: jobguard run <ms> <cwd> <cmdline>"); std::process::exit(2) }
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
        let mut lim: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        lim.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &lim as *const _ as *const _, std::mem::size_of_val(&lim) as u32) == 0 {
            err("SetInformationJobObject", GetLastError())
        }
        let mut si: STARTUPINFOW = std::mem::zeroed();
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        if CreateProcessW(std::ptr::null(), cmdw.as_mut_ptr(), std::ptr::null(), std::ptr::null(), 1, CREATE_SUSPENDED, std::ptr::null(),
            cwdw.as_ref().map_or(std::ptr::null(), |w| w.as_ptr()), &si, &mut pi) == 0 {
            err("CreateProcess", GetLastError())
        }
        if AssignProcessToJobObject(job, pi.hProcess) == 0 {
            let e = GetLastError();
            TerminateProcess(pi.hProcess, 127);   // never leave it suspended and unguarded
            err("AssignProcessToJobObject", e)
        }
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);
        if WaitForSingleObject(pi.hProcess, ms) != WAIT_OBJECT_0 {
            let _ = writeln!(std::io::stderr(), "jobguard-timeout {ms} ms");
            TerminateJobObject(job, 124);   // the child and everything it started
            std::process::exit(124)
        }
        let mut code = 0u32;
        GetExitCodeProcess(pi.hProcess, &mut code);
        std::process::exit(code as i32)   // the job handle closes with this process: KILL_ON_JOB_CLOSE ends what the child left
    }
}

#[cfg(not(windows))]
fn main() { eprintln!("jobguard-err jobguard-rs is Windows only"); std::process::exit(127) }
