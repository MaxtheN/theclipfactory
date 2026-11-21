; Inno Setup script for the Windows 10/11 x64 installer. Built by scripts/build-desktop-app.py:
;   iscc /DAppVersion=0.1.0 /DBundleDir=dist\Growth Factory /DWebView2Setup=build\webview2\MicrosoftEdgeWebview2Setup.exe
;        /DOutputDir=dist packaging\windows\growth-factory.iss
; The build script Authenticode-signs the app and this installer when a signer is configured
; (docs/releasing.md); unsigned builds make Windows SmartScreen warn before the first run.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef BundleDir
  #error BundleDir (the PyInstaller "Growth Factory" folder) is required
#endif
#ifndef WebView2Setup
  #error WebView2Setup (Microsoft's Evergreen bootstrapper) is required
#endif
#ifndef OutputDir
  #define OutputDir "dist"
#endif

[Setup]
AppId={{6F4B7B2E-8C1D-4E7A-9B3F-2D5C8A0E1F47}
AppName=Growth Factory
AppVersion={#AppVersion}
AppPublisher=Growth Factory
AppPublisherURL=https://github.com/MaxtheN/theclipfactory
VersionInfoVersion={#AppVersion}
; Per-user install under %LOCALAPPDATA%\Programs: no administrator rights needed.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={autopf}\Growth Factory
DefaultGroupName=Growth Factory
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=growth-factory-windows-x64-setup
SetupIconFile=..\icons\growth-factory.ico
UninstallDisplayIcon={app}\Growth Factory.exe
UninstallDisplayName=Growth Factory
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#BundleDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#WebView2Setup}"; Flags: dontcopy

[InstallDelete]
; A new version replaces the bundled files; the creator's data lives under %LOCALAPPDATA%, not here.
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{autoprograms}\Growth Factory"; Filename: "{app}\Growth Factory.exe"
Name: "{autodesktop}\Growth Factory"; Filename: "{app}\Growth Factory.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Growth Factory.exe"; Description: "{cm:LaunchProgram,Growth Factory}"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebView2Client = '\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2Page = 'https://developer.microsoft.com/microsoft-edge/webview2/';

function HasWebView2Version(RootKey: Integer; SubKey: String): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(RootKey, SubKey, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0');
end;

{ The app window is Microsoft Edge WebView2. Windows 11 includes it; most Windows 10 machines have it. }
function WebView2Installed: Boolean;
begin
  Result := HasWebView2Version(HKLM, 'SOFTWARE\WOW6432Node' + WebView2Client)
    or HasWebView2Version(HKLM, 'SOFTWARE' + WebView2Client)
    or HasWebView2Version(HKCU, 'Software' + WebView2Client);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  ErrorCode: Integer;
begin
  if (CurStep <> ssPostInstall) or WebView2Installed then
    Exit;
  WizardForm.StatusLabel.Caption := 'Installing Microsoft Edge WebView2, which shows the app window...';
  ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
  Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_SHOW,
    ewWaitUntilTerminated, ResultCode);
  if not WebView2Installed then
  begin
    if MsgBox('Growth Factory needs Microsoft Edge WebView2 to show its window, and it could not be installed '
      + 'automatically. Open the WebView2 download page now?', mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', WebView2Page, '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
  end;
end;
