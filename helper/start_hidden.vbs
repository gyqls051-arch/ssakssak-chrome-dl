' SsakSsak helper - launch with NO console window (silent background).
' Double-click to run invisibly, or let autostart use it on login.
Dim fso, sh, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
' 0 = hidden window, False = don't wait. Uses pythonw.exe (no console).
sh.Run "pythonw.exe """ & dir & "\helper.py""", 0, False
