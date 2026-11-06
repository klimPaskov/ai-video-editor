; Urushi Windows installer (NSIS 3, Unicode, per-user, 64-bit only).
;
; Built by scripts/windows/installer.ts with `makensis`; the defines below are
; passed on the command line. The installer is UNSIGNED unless the builder is
; given a signing command (docs/adr/0022-windows-release.md).
;
; Install: per user, no administrator prompt, into
;   %LOCALAPPDATA%\Programs\Urushi
; with one Start-menu shortcut and a normal Apps & features entry.
;
; Uninstall: removes exactly the files this installer wrote (the generated
; list in UNINSTALL_LIST), the shortcut and the registry entry. It never
; touches %APPDATA%\ai-video-editor, where projects, the media library,
; recordings, exports and settings live. A folder that still holds anything
; else is left in place.

Unicode true
ManifestDPIAware true
RequestExecutionLevel user

!ifndef PRODUCT_NAME
  !error "PRODUCT_NAME is required"
!endif
!ifndef PRODUCT_VERSION
  !error "PRODUCT_VERSION is required"
!endif
!ifndef PRODUCT_VERSION_QUAD
  !error "PRODUCT_VERSION_QUAD is required"
!endif
!ifndef SOURCE_DIR
  !error "SOURCE_DIR is required"
!endif
!ifndef OUT_FILE
  !error "OUT_FILE is required"
!endif
!ifndef UNINSTALL_LIST
  !error "UNINSTALL_LIST is required"
!endif
!ifndef LICENSE_FILE
  !error "LICENSE_FILE is required"
!endif
!ifndef EXE_NAME
  !define EXE_NAME "ai-video-editor.exe"
!endif
!ifndef PUBLISHER
  !define PUBLISHER "Urushi project"
!endif

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ai-video-editor"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"

Name "${PRODUCT_NAME}"
OutFile "${OUT_FILE}"
BrandingText "${PRODUCT_NAME} ${PRODUCT_VERSION}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"

!ifdef FAST
  ; Smoke-test builds only: quick to compile, large to download.
  SetCompressor zlib
!else
  SetCompressor /SOLID lzma
  SetCompressorDictSize 64
!endif

VIProductVersion "${PRODUCT_VERSION_QUAD}"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "FileDescription" "${PRODUCT_NAME} installer"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "LegalCopyright" "MIT licence; see the licence page"

!ifdef SIGN_COMMAND
  !finalize '${SIGN_COMMAND} "%1"'
  !uninstfinalize '${SIGN_COMMAND} "%1"'
!endif

!define MUI_ABORTWARNING
!ifdef ICON_FILE
  !define MUI_ICON "${ICON_FILE}"
  !define MUI_UNICON "${ICON_FILE}"
!endif
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE_NAME}"
!define MUI_FINISHPAGE_RUN_TEXT "Open ${PRODUCT_NAME}"
!insertmacro MUI_PAGE_LICENSE "${LICENSE_FILE}"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ; /CODEX on the command line (for silent installs) includes the optional
  ; Codex connection, which is otherwise left out.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/CODEX" $R1
  ${IfNot} ${Errors}
    SectionSetFlags ${SecCodex} ${SF_SELECTED}
  ${EndIf}

  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "${PRODUCT_NAME} needs 64-bit Windows 10 or newer."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "${PRODUCT_NAME} needs Windows 10 or newer."
    Abort
  ${EndIf}

  ; Say so when the app is already installed, and ask before replacing it.
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\${EXE_NAME}"
    ReadRegStr $1 HKCU "${UNINSTALL_KEY}" "DisplayVersion"
    ${IfNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION "${PRODUCT_NAME} $1 is already installed.$\r$\n$\r$\nReplace it with ${PRODUCT_VERSION}? Your projects and settings are kept." IDYES +2
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "Urushi" SecCore
  SectionIn RO
  SetShellVarContext current

  ; Replace an earlier install cleanly by running its own uninstaller, which
  ; keeps the user's projects.
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\Uninstall.exe"
    ExecWait '"$0\Uninstall.exe" /S _?=$0'
    Delete "$0\Uninstall.exe"
    RMDir "$0"
  ${EndIf}

  ; Everything except the optional Codex connection (about 380 MB), which
  ; is its own section below so the default install stays small and quick.
  SetOutPath "$INSTDIR"
  File /r /x codex "${SOURCE_DIR}/*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${EXE_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  SectionGetSize ${SecCore} $1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" $1
SectionEnd

; Claude is the default connection. Codex is an alternative that needs its
; own runtime; it is left out unless chosen (silent installs: /o sections are
; skipped). The app says plainly when it is missing.
Section /o "Codex connection (optional, adds about 380 MB)" SecCodex
  SetShellVarContext current
  SetOutPath "$INSTDIR\resources\codex"
  File /r "${SOURCE_DIR}/resources/codex/*"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCore} "The video editor with the Claude connection."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCodex} "The Codex (ChatGPT) connection as an alternative to Claude. Large; skip it unless you use Codex."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  SetShellVarContext current

  Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"

  !include "${UNINSTALL_LIST}"

  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  ${IfNot} ${Silent}
    MessageBox MB_OK|MB_ICONINFORMATION "${PRODUCT_NAME} was removed. Your projects, recordings and settings were kept in $APPDATA\ai-video-editor."
  ${EndIf}
SectionEnd
