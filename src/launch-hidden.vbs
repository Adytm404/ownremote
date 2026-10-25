' OwnRemote: start the background server without a console window.
' Used by the "Start with Windows" registry entry (HKCU\Software\Microsoft\Windows\CurrentVersion\Run).
' Usage: wscript.exe launch-hidden.vbs "<node.exe>" "<daemon.js>" [--startup]
Option Explicit
Dim args, command, i
Set args = WScript.Arguments
If args.Count < 2 Then WScript.Quit 1
command = Chr(34) & args(0) & Chr(34) & " " & Chr(34) & args(1) & Chr(34)
For i = 2 To args.Count - 1
  command = command & " " & args(i)
Next
' 0 = no window, False = do not wait
CreateObject("WScript.Shell").Run command, 0, False
