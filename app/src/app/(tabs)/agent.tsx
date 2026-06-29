import React from "react";

import { AgentScreen } from "../../screens/AgentScreen.tsx";
import { useConnection } from "../../ConnectionContext.tsx";

export default function AgentRoute() {
  const { client, provider } = useConnection();
  if (!client) return null;
  return <AgentScreen client={client} provider={provider} />;
}
