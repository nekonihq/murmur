import React from "react";

import { AgentScreen } from "../../screens/AgentScreen.tsx";
import { useConnection } from "../../ConnectionContext.tsx";

export default function AgentRoute() {
  const { client, provider, deviceId } = useConnection();
  if (!client || !deviceId) return null;
  return <AgentScreen client={client} provider={provider} deviceId={deviceId} />;
}
