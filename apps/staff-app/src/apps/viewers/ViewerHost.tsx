import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";

import { fileNameOf, viewerKindFor } from "./kind";
import { ViewerLoading, ViewerMessage } from "./ViewerMessage";

// Every viewer is its own chunk, fetched the first time a file of that kind is
// opened (PRD 22.4). Nothing here is imported by the desktop or the taskbar.
const ImageViewer = lazy(() => import("./ImageViewer"));
const MediaPlayer = lazy(() => import("./MediaPlayer"));
const TextViewer = lazy(() => import("./TextViewer"));
const CsvViewer = lazy(() => import("./CsvViewer"));
const PdfViewer = lazy(() => import("./PdfViewer"));
const DocxViewer = lazy(() => import("./DocxViewer"));
const XlsxViewer = lazy(() => import("./XlsxViewer"));
const Unsupported = lazy(() => import("./Unsupported"));

/** What shows for a file: its viewer, picked from the name, or "Preview not available". */
export function ViewerHost({ path }: { path: string }) {
  const kind = viewerKindFor(fileNameOf(path));
  return (
    // A new file gets a fresh viewer and a fresh error state.
    <ViewerBoundary key={path} name={fileNameOf(path)}>
      <Suspense fallback={<ViewerLoading />}>
        {kind === "image" ? (
          <ImageViewer path={path} />
        ) : kind === "media" ? (
          <MediaPlayer path={path} />
        ) : kind === "text" ? (
          <TextViewer path={path} />
        ) : kind === "csv" ? (
          <CsvViewer path={path} />
        ) : kind === "pdf" ? (
          <PdfViewer path={path} />
        ) : kind === "docx" ? (
          <DocxViewer path={path} />
        ) : kind === "xlsx" ? (
          <XlsxViewer path={path} />
        ) : (
          <Unsupported path={path} />
        )}
      </Suspense>
    </ViewerBoundary>
  );
}

/** A viewer that crashes must not blank the whole window. */
class ViewerBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Viewer failed:", error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return <ViewerMessage title="This file can't be shown." detail={this.props.name} />;
    }
    return this.props.children;
  }
}
