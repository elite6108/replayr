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
  ${If} $UpdateMode != 1
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  ${EndIf}
!macroend