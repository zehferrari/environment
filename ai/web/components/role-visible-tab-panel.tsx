import { TabPanel } from "@/components/task-tabs";

export default function RoleVisibleTabPanel({
  visible,
  name,
  children,
}: {
  visible: boolean;
  name: string;
  children: React.ReactNode;
}) {
  if (!visible) return null;
  return <TabPanel name={name}>{children}</TabPanel>;
}
