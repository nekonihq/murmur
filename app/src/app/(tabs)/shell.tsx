import React from "react";

import { ShellScreen } from "../../screens/ShellScreen.tsx";
import { useConnection } from "../../ConnectionContext.tsx";

export default function ShellRoute() {
  const { client } = useConnection();
  if (!client) return null;
  return <ShellScreen client={client} />;
}
