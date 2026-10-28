; the windows setup wizard. tools/build.sh compiles it with -DVERSION, -DSOURCE
; (the folder to install), -DOUTFILE, -DICON and -DFILES (what the uninstaller removes).

Unicode true
!include "MUI2.nsh"

Name "Meadow"
OutFile "${OUTFILE}"
; per user: no administrator prompt, and an update needs none either
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\Meadow"
InstallDirRegKey HKCU "Software\Meadow" "InstallDir"
SetCompressor /SOLID lzma
BrandingText "Meadow ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Meadow"
VIAddVersionKey "FileDescription" "Meadow Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" ""

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Meadow.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start Meadow"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Meadow"

Section "Meadow"
  SetOutPath "$INSTDIR"
  File /r "${SOURCE}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall Meadow.exe"

  CreateShortcut "$SMPROGRAMS\Meadow.lnk" "$INSTDIR\Meadow.exe"
  CreateShortcut "$DESKTOP\Meadow.lnk" "$INSTDIR\Meadow.exe"

  WriteRegStr HKCU "Software\Meadow" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Meadow"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Meadow"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\Meadow.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall Meadow.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

  ; meadow:// links, from the account page's "Sign in with the Meadow client"
  ; (app/main.js writes the same when it starts)
  WriteRegStr HKCU "Software\Classes\meadow" "" "URL:meadow"
  WriteRegStr HKCU "Software\Classes\meadow" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\meadow\shell\open\command" "" '"$INSTDIR\Meadow.exe" "%1"'
SectionEnd

; only what was installed goes: the folder may be one the player chose, with
; other things in it. remembered accounts and settings live elsewhere and stay.
Section "Uninstall"
  !include "${FILES}"
  Delete "$INSTDIR\Uninstall Meadow.exe"
  RMDir "$INSTDIR"

  Delete "$SMPROGRAMS\Meadow.lnk"
  Delete "$DESKTOP\Meadow.lnk"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\Meadow"
  DeleteRegKey HKCU "Software\Classes\meadow"
SectionEnd
