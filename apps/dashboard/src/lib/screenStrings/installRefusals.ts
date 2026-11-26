/**
 * The sentences for the refusals of the installer details and of `apps:inspectInstaller` (Phase 6 Step 13). The App screen registers them with
 * `registerDetailSentences` (lib/errors.ts), like the update-mode refusals: a few hundred bytes, so they ride the screen's own chunk.
 */
export const installRefusalStrings = {
  inspect_blocked: "Rulebox can't read that address: it must be a public https:// address. Fill the switches in by hand, or check a copy of the file on this computer.",
  inspect_unsupported: "That server doesn't allow partial downloads, so Rulebox can't look inside the file. Fill the switches in by hand, or check a copy of the file on this computer.",
  inspect_failed: "Rulebox could not read the file at that address. Check the address and try again.",
  inspect_not_installer: "The file at that address is not a Windows program or an MSI package.",
  answer_file_unused: "The answer file is not used: put {AnswerFile} in the silent install arguments.",
  answer_file_missing: "{AnswerFile} is in the arguments but there is no answer file. Turn on “Use an answer file” and give it.",
  answer_file_not_iss: "The answer file's address must end in .iss.",
  silent_arg_token: "Only {AnswerFile}, {LogFile} and {InstallDir} may be written in braces in the silent install arguments.",
  install_dir_token: "{InstallDir} only works as /D={InstallDir} (last argument, NSIS) or /DIR={InstallDir} (Inno Setup), and for a program under {ProgramFiles} or {ProgramFilesX86} without a * in its path.",
} as const;


/** The inline messages of the installer fields and the "edited" mark: needed when the form is checked, so they are not in the lazy chunk. */
export const installFormStrings = {
  edited: "edited",
  successCodesBad: "Use whole numbers separated by commas, at most 16.",
  timeoutBad: "Use a whole number from 5 to 120, or leave it empty.",
  publisherBad: "At most 200 characters.",
  answerUrlBad: "Use an https:// address ending in .iss.",
  answerNeedsToken: "Put {AnswerFile} in the silent install arguments, where the installer takes its answer file.",
  tokenNeedsAnswer: "{AnswerFile} is in the arguments, so turn on “Use an answer file” and give the file.",
  tokenBad: "Only {AnswerFile}, {LogFile} and {InstallDir} may be written in braces.",
} as const;