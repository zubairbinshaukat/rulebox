import { useLocation, useNavigate } from "react-router";
import { Button } from "@rulebox/ui";
import { useAuthActions } from "../data";
import { withNext } from "../lib/next";
import { sec } from "../lib/stepup/strings";

/** Sign out and back in: a fresh sign-in opens the 15-minute window to set the first factor. */
export function SignOutAndIn({ label = sec.signOutAndIn, variant = "primary" }: { label?: string; variant?: "primary" | "ghost" }) {
  const { signOut } = useAuthActions();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <Button
      variant={variant}
      className={variant === "primary" ? "dash-btn--accent" : undefined}
      onClick={() => {
        const here = location.pathname + location.search;
        void signOut().then(() => navigate(withNext("/sign-in", here), { replace: true }));
      }}
    >
      {label}
    </Button>
  );
}
