; Included by electron-builder in the Windows installer.
;
; The folder page: electron-builder's own (nsis.allowToChangeInstallationDirectory) also makes every manual upgrade
; remove the old shortcuts instead of keeping them, which unpins the app from the taskbar. This adds the same page
; without that side effect. Upgrades into the same folder keep the shortcuts (and the pin); choosing another folder
; recreates them there.
!macro customPageAfterChangeDir
  !include StrContains.nsh

  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_DIRECTORY

  ; Like electron-builder's: make sure the chosen folder ends in an application sub-folder.
  !define MUI_PAGE_CUSTOMFUNCTION_PRE shardwiseInstFilesPre
  Function shardwiseInstFilesPre
    ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
    ${If} $0 == ""
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${endIf}
  FunctionEnd
!macroend
