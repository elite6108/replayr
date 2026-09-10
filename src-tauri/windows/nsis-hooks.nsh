; This Tauri crate has no nsis.oneClick field. Force a current-user extract:
; skip wizard pages, leave desktop shortcuts to the in-app prompt, then launch.
;
; installerHooks is included BEFORE `Var PassiveMode` / `Var NoShortcutMode`,
; so `.onGUIInit` cannot StrCpy those vars (makensis: "Usage: StrCpy ...").
SilentInstall silent

!macro NSIS_HOOK_PREINSTALL
  StrCpy $NoShortcutMode 1
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Win10 Fixed Version 120+ needs App Container RX on the bundled runtime.
  IfFileExists "$INSTDIR\webview2-fixed\msedgewebview2.exe" 0 skip_webview_acl
    nsExec::ExecToLog 'icacls "$INSTDIR\webview2-fixed" /grant *S-1-15-2-1:(OI)(CI)(RX)'
    nsExec::ExecToLog 'icacls "$INSTDIR\webview2-fixed" /grant *S-1-15-2-2:(OI)(CI)(RX)'
  skip_webview_acl:
  ${If} $UpdateMode != 1
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  ${EndIf}
!macroend
