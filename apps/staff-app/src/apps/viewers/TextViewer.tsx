import { useEffect, useState } from "react";
import type { TextPreview } from "@rulebox/types";

import { fileErrorText } from "../files/errors";
import { call } from "../../lib/tauri";
import { TextBody } from "./TextBody";
import { ViewerBanner, ViewerLoading, ViewerMessage } from "./ViewerMessage";

/** Plain text, read-only. It goes in as text, never as markup. */
export default function TextViewer({ path }: { path: string }) {
  const [state, setState] = useState<{ preview: TextPreview } | { error: string } | null>(null);

  useEffect(() => {
    let current = true;
    void call("fs_read_text", { path }).then(
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
      <TextBody text={state.preview.text} />
    </>
  );
}
