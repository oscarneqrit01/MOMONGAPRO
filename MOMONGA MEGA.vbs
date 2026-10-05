' Lanzador de MOMONGA BOT: arranca el servidor OCULTO y abre la app en ventana tipo app.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

' 1) Arranca el bot oculto (sin consola visible)
sh.Run "cmd /c """ & dir & "\iniciar-bot.bat""", 0, False

' 2) Espera a que arranque
WScript.Sleep 7000

url = "http://localhost:3100/cliente"

' 3) Abre en ventana tipo app (Chrome, luego Edge)
chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
If Not fso.FileExists(chrome) Then chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
If Not fso.FileExists(chrome) Then chrome = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Google\Chrome\Application\chrome.exe"

edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
If Not fso.FileExists(edge) Then edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"

If fso.FileExists(chrome) Then
  sh.Run """" & chrome & """ --app=""" & url & """ --window-size=1200,820 --window-position=80,40", 1, False
ElseIf fso.FileExists(edge) Then
  sh.Run """" & edge & """ --app=""" & url & """ --window-size=1200,820 --window-position=80,40", 1, False
Else
  sh.Run url, 1, False
End If
