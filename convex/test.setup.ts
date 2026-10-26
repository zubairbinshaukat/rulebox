/// <reference types="vite/client" />

// Every module under convex/ for convex-test. The file name has two dots, so
// the Convex bundler skips it (it is never pushed).
export const modules = import.meta.glob("./**/*.*s");
