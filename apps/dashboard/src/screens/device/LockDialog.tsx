import { useState } from "react";
import { Button } from "@rulebox/ui";
import { useUnlockDevice } from "../../data";
import type { Id } from "../../data/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Modal } from "../../components/Modal";
import { useToast } from "../../lib/toast";
import { LockForm, type LockTarget } from "../broadcasts/LockCard";
import { lockStrings as ls } from "../broadcasts/strings";
import { deviceText as t } from "./strings";

/** Unlock one PC after a confirmation (the "Unlock" of the header, the lock dialog and the "locked" problem). */
export function UnlockDialog({ deviceId, open, onClose }: { deviceId: Id; open: boolean; onClose: () => void }) {
  const unlock = useUnlockDevice();
  const toast = useToast();
  return (
    <ConfirmDialog
      open={open}
      title={ls.unlockTitle}
      body={ls.unlockBody}
      confirmLabel={ls.unlock}
      onConfirm={() => unlock({ deviceId })}
      onDone={() => toast(ls.unlocked_ok)}
      onClose={onClose}
    />
  );
}

/**
 * Lock this PC (plan 4.17, D13): the message, the contact and a preview of what the PC shows, in a dialog every tab can open. When the
 * PC is already locked the same dialog updates the lock, and its Unlock button hands over to the confirmation.
 */
export function LockDialog({ d, open, onClose }: { d: LockTarget; open: boolean; onClose: () => void }) {
  const [unlocking, setUnlocking] = useState(false);
  const locked = d.lock !== null;
  return (
    <>
      <Modal
        open={open && !unlocking}
        wide
        title={locked ? t.lockedDialogTitle : t.lockDialogTitle}
        onClose={onClose}
        actions={
          <Button variant="ghost" onClick={onClose}>
            {t.close}
          </Button>
        }
      >
        <div className="dash-form">
          <p className="dash-muted">{ls.lead}</p>
          {/* A fresh form per lock: its fields start from the lock that is in force. */}
          <LockForm key={d.lock?.lockId ?? "none"} d={d} onDone={onClose} onUnlock={() => setUnlocking(true)} />
        </div>
      </Modal>
      <UnlockDialog
        deviceId={d._id}
        open={open && unlocking}
        onClose={() => {
          setUnlocking(false);
          onClose();
        }}
      />
    </>
  );
}
