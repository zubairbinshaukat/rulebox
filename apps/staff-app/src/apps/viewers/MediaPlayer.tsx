import { useMemo, useState, type CSSProperties } from "react";

import { fileNameOf, isVideo, mediaMime, rbfileUrl } from "./kind";
import { OpenWith } from "./OpenWith";
import { ViewerMessage } from "./ViewerMessage";

/**
 * Audio or video with the browser's own controls. Seeking works because the
 * `rbfile` protocol answers range requests. No download, no remote playback,
 * no picture-in-picture.
 */
export default function MediaPlayer({ path }: { path: string }) {
  const name = fileNameOf(path);
  const video = isVideo(name);
  const [failed, setFailed] = useState(false);

  // An empty answer means this engine has no decoder for the format.
  const playable = useMemo(() => {
    const mime = mediaMime(name);
    if (!mime) return false;
    const probe = document.createElement(video ? "video" : "audio");
    return probe.canPlayType(mime) !== "";
  }, [name, video]);

  if (failed || !playable) {
    return (
      <ViewerMessage title="This file can't be played here." detail={name}>
        <OpenWith path={path} />
      </ViewerMessage>
    );
  }

  const shared = {
    src: rbfileUrl(path),
    controls: true,
    controlsList: "nodownload noremoteplayback",
    preload: "metadata" as const,
    onError: () => setFailed(true),
    "aria-label": name,
  };

  return (
    <div style={stage}>
      {video ? (
        <video {...shared} disablePictureInPicture disableRemotePlayback style={videoStyle} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, width: "min(560px, 90%)" }}>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>{name}</p>
          <audio {...shared} style={{ width: "100%" }} />
        </div>
      )}
    </div>
  );
}

const stage: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--rb-bg)",
  color: "var(--rb-ink)",
  padding: 16,
};

const videoStyle: CSSProperties = {
  maxWidth: "100%",
  maxHeight: "100%",
  background: "#000",
  borderRadius: 12,
};
