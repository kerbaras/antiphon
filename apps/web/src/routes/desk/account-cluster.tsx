// Top-bar account cluster (auth mode only; lazy — the only desk chrome
// that imports @clerk/react): the operator's own account button.
// Desk-access sharing lives in the avatar-stack "+" popover.

import { UserButton } from "@clerk/react";

export default function AccountCluster() {
  return <UserButton />;
}
