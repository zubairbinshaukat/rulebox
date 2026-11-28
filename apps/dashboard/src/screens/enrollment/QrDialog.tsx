import { useEffect, useState } from "react";
import { Button } from "@rulebox/ui";
import { Modal } from "../../components/Modal";
import { strings } from "../../lib/strings";
import type { QrCode } from "../../lib/qr";
import { enrollText as s } from "./strings";

export interface QrDialogProps {
  open: boolean;
  /** The enrollment code, exactly as created. It is drawn, never shown as text, and dropped when the dialog closes. */
  code: string;
  onClose: () => void;
}

/**
 * "Scan the code": the enrollment code (and nothing else: no address, no link) as a QR code, for a phone or tablet. Made in this
 * browser by `lib/qr.ts`, whose encoder is its own chunk that loads only when this opens (so the Add a PC screen can import this
 * dialog normally). Closing unmounts it: the picture and the code are gone with the component, nothing is kept.
 */
export function QrDialog({ open, code, onClose }: QrDialogProps) {
  if (!open) return null;
  // A fresh inner component per opening: no picture of an earlier code can show first.
  return <QrInner code={code} onClose={onClose} />;
}

function QrInner({ code, onClose }: { code: string; onClose: () => void }) {
  const [qr, setQr] = useState<QrCode | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    import("../../lib/qr")
      .then((m) => m.makeQr(code))
      .then((made) => {
        if (current) setQr(made);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [code]);

  return (
    <Modal
      open
      title={s.qrTitle}
      onClose={onClose}
      actions={
        <Button variant="primary" onClick={onClose}>
          {strings.common.close}
        </Button>
      }
    >
      <div className="dash-qr">
        {qr ? (
          <div className="dash-qr__box">
            <svg className="dash-qr__svg" viewBox={`0 0 ${qr.viewBox} ${qr.viewBox}`} role="img" aria-label={s.qrLabel} shapeRendering="crispEdges">
              <rect width={qr.viewBox} height={qr.viewBox} fill="#fff" />
              <path d={qr.path} fill="#000" />
            </svg>
          </div>
        ) : failed ? (
          <p className="dash-qr__failed" role="alert">
            {s.qrFailed}
          </p>
        ) : (
          <div className="dash-qr__box" aria-busy="true" />
        )}
        <p className="dash-qr__hint">{s.qrHint}</p>
      </div>
    </Modal>
  );
}
