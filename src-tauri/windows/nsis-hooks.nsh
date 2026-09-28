; This Tauri crate has no nsis.oneClick field. Force a current-user extract:
; skip wizard pages, leave desktop shortcuts to the in-app prompt, then launch.
;
; installerHooks is included BEFORE `Var PassiveMode` / `Var NoShortcutMode`,
; so `.onGUIInit` cannot StrCpy those vars (makensis: "Usage: StrCpy ...").
SilentInstall silent

!macro NSIS_HOOK_PREINSTALL
  StrCpy $NoShortcutMode 1
  ; Re-running an old Desktop Replayr.exe must not overwrite a newer install.
  ${If} $UpdateMode != 1
    IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 skip_downgrade_guard
      GetDLLVersion "$INSTDIR\${MAINBINARYNAME}.exe" $R6 $R7
      GetDLLVersion "$EXEPATH" $R8 $R9
      ; If this setup has no version resource, do not guess.
      IntCmpU $R8 0 check_installer_lo has_installer_ver has_installer_ver
      check_installer_lo:
        IntCmpU $R9 0 skip_downgrade_guard has_installer_ver has_installer_ver
      has_installer_ver:
        ; Installed >= this installer → launch existing and quit.
        IntCmpU $R6 $R8 same_hi skip_downgrade_guard installed_newer
        same_hi:
          IntCmpU $R7 $R9 installed_newer skip_downgrade_guard installed_newer
        installed_newer:
          nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
          SetErrorLevel 0
          Quit
    skip_downgrade_guard:
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$SMPROGRAMS"
  CreateShortCut "$SMPROGRAMS\Replayr.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  ${If} $UpdateMode != 1
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  ${EndIf}
!macroend
