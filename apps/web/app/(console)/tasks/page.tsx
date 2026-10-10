import { fetchTasks } from "@/lib/polymer";
import { TaskBoard } from "./task-board";

export default async function TasksPage(): Promise<React.JSX.Element> {
  const tasks = await fetchTasks();
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
      <div className="mt-4">
        <TaskBoard initial={tasks} />
      </div>
    </div>
  );
}
