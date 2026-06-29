import React from "react";

import { SettingsScreen } from "../../screens/SettingsScreen.tsx";
import { useConnection } from "../../ConnectionContext.tsx";

export default function SettingsRoute() {
  const { refreshProvider } = useConnection();
  return <SettingsScreen onChanged={refreshProvider} />;
}
