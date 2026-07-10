// W8-A top-bar account cluster (auth mode only; lazy — the only desk
// chrome that imports @clerk/react): the operator's own account button.
// Desk-access sharing moved INTO the avatar-stack "+" popover (operator
// ask — one popover carries the mic invite AND desk access, each stating
// its capability), so the old Share button is gone.

import { UserButton } from "@clerk/react";

export default function AccountCluster() {
  return <UserButton />;
}
