// Windows Task Scheduler (D13): schtasks /Create /XML keeps IgnoreNew, hidden, battery, 55 min limit (= today's install.ps1).
// proc-hygiene (8, 2026-11-19): the action is `wscript.exe //B local/<task>.vbs`, which starts the tick with
// WScript.Shell.Run(cmd, 0, True): hidden from creation and waited for, so IgnoreNew and the 55 min limit still hold. The PowerShell
// action before it ('-WindowStyle Hidden') opened an empty Windows Terminal window for the whole tick wherever Terminal is the
// default terminal (the console is handed to Terminal before PowerShell can hide it); closing that window killed the tick.
// 'conhost --headless' failed there (0x80070005). GOLDEN-TESTED ONLY in S5.
import { generic, tickArgv, realIo, ownerOf } from './common.mjs';
import { winQuote } from '../jobguard.mjs';

const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const win = p => (/^[a-z]:\//i.test(p) ? String(p).replace(/\//g, '\\') : String(p));   // a drive path in Windows form; any other word as is
const vbsStr = s => `"${String(s).replace(/"/g, '""')}"`;
/** the .vbs the task runs: Run(the tick's command line, 0 = no window, True = wait for it). LF line ends: WSH reads them, and the
 * golden stays byte-equal through git's line-ending conversion */
export const tickVbs = o => '\' Norn tick launcher (norn sched install, engine/lib/sched/win.mjs): the tick with no window, waited for.\n'
  + `CreateObject("WScript.Shell").Run ${vbsStr(tickArgv(o).map(a => winQuote(win(a))).join(' '))}, 0, True\n`;
/** an installed task's XML that still starts the tick through PowerShell (the action before proc-hygiene: a visible window) */
export const oldAction = xml => /<Command>\s*powershell(\.exe)?\s*<\/Command>/i.test(String(xml || ''));
export function plan(o) {
  const file = `${o.meta}/local/${o.name}.task.xml`, vbs = `${o.meta}/local/${o.name}.vbs`;
  const user = o.user || `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const args = `//B //NoLogo ${winQuote(win(vbs))}`;
  const content = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Norn tick: norn status + one check-in per project, every ${o.interval_min} min</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition><Interval>PT${o.interval_min}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>${x(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT55M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>wscript.exe</Command><Arguments>${x(args)}</Arguments><WorkingDirectory>${x(o.meta)}</WorkingDirectory></Exec>
  </Actions>
</Task>
`;
  return { files: [{ path: vbs, content: tickVbs(o), encoding: 'utf16le' }, { path: file, content, encoding: 'utf16le' }],
    install: [['schtasks', '/Create', '/TN', o.name, '/XML', file, '/F']],
    remove: [['schtasks', '/Delete', '/TN', o.name, '/F'], ['rm', file], ['rm', vbs]] };
}
export default { ...generic(plan, (o, io = realIo) => io.run('schtasks', ['/Query', '/TN', o.name]).status === 0),
  owner: (o, io = realIo) => { const r = io.run('schtasks', ['/Query', '/TN', o.name, '/XML']); return r.status === 0 ? ownerOf(String(r.stdout || '')) : null; },
  windowed: (o, io = realIo) => { const r = io.run('schtasks', ['/Query', '/TN', o.name, '/XML']); return r.status === 0 && oldAction(r.stdout); } };
