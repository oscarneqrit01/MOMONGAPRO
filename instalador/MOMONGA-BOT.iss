; Instalador de MOMONGA MEGA (para la PC del cliente)
; Compilar con Inno Setup 6 (ISCC.exe MOMONGA-BOT.iss)

#define AppName "MOMONGA MEGA"
#define AppVersion "22"
#define AppPublisher "MOMONGA"

[Setup]
AppId={{8B2E4C1A-9F3D-4A6E-B7C1-2D5F8A0E3C77}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\MOMONGA MEGA
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=MOMONGA-MEGA-Setup-22
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "Crear acceso directo en el Escritorio"; GroupDescription: "Accesos directos:"

[Files]
Source: "..\node\*"; DestDir: "{app}\node"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\node_modules\*"; DestDir: "{app}\node_modules"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\public\*"; DestDir: "{app}\public"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\server.js"; DestDir: "{app}"
Source: "..\package.json"; DestDir: "{app}"
Source: "cliente-iniciar-cliente.bat"; DestDir: "{app}"; DestName: "iniciar-cliente.bat"
Source: "cliente-iniciar-bot.bat"; DestDir: "{app}"; DestName: "iniciar-bot.bat"
Source: "..\abrir-app.bat"; DestDir: "{app}"
Source: "..\MOMONGA MEGA.vbs"; DestDir: "{app}"
Source: "..\momonga.ico"; DestDir: "{app}"

[Icons]
Name: "{userprograms}\MOMONGA MEGA"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\MOMONGA MEGA.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\momonga.ico"
Name: "{userdesktop}\MOMONGA MEGA"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\MOMONGA MEGA.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\momonga.ico"; Tasks: desktopicon

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\MOMONGA MEGA.vbs"""; Description: "Abrir MOMONGA MEGA ahora"; Flags: postinstall nowait
