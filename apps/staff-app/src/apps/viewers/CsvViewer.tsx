import { useEffect, useState } from "react";
import type { CsvPreview } from "@rulebox/types";

import { fileErrorText } from "../files/errors";
import { call } from "../../lib/tauri";
import { CsvTable } from "./CsvTable";
import { ViewerBanner, ViewerLoading, ViewerMessage } from "./ViewerMessage";

export default function CsvViewer({ path }: { path: string }) {
  const [state, setState] = useState<{ preview: CsvPreview } | { error: string } | null>(null);

  useEffect(() => {
    let current = true;
    void call("fs_read_csv", { path }).then(
      (preview) => {
        if (current) setState({ preview });
      },
      (error) => {
        if (current) setState({ error: fileErrorText(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [path]);

  if (!state) return <ViewerLoading />;
  if ("error" in state) return <ViewerMessage title="This file can't be shown." detail={state.error} />;
  return (
    <>
      {state.preview.truncated ? <ViewerBanner>Showing the first part of this file.</ViewerBanner> : null}
      <CsvTable rows={state.preview.rows} />
    </>
  );
}
