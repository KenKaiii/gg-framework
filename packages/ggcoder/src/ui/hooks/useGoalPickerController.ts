import { useCallback, useState } from "react";
import {
  loadGoalRuns,
  loadGoalRunsSync,
  saveGoalRuns,
  type GoalRun,
} from "../../core/goal-store.js";

interface UseGoalPickerControllerOptions {
  cwd: string;
  onRunGoal: (run: GoalRun) => void;
  onDeleteGoalSideEffects: (run: GoalRun) => Promise<void> | void;
  onPauseGoal: (run: GoalRun) => void;
  onError: (err: unknown) => void;
}

interface GoalPickerController {
  open: boolean;
  goals: GoalRun[];
  close: () => void;
  openPicker: () => void;
  toggle: () => void;
  run: (run: GoalRun) => void;
  deleteGoal: (run: GoalRun) => void;
  pause: (run: GoalRun) => void;
  refresh: () => void;
}

export function useGoalPickerController({
  cwd,
  onRunGoal,
  onDeleteGoalSideEffects,
  onPauseGoal,
  onError,
}: UseGoalPickerControllerOptions): GoalPickerController {
  const [open, setOpen] = useState(false);
  const [goals, setGoals] = useState<GoalRun[]>(() => loadGoalRunsSync(cwd));

  const refresh = useCallback(() => setGoals(loadGoalRunsSync(cwd)), [cwd]);
  const close = useCallback(() => setOpen(false), []);

  const openPicker = useCallback(() => {
    setGoals(loadGoalRunsSync(cwd));
    setOpen(true);
  }, [cwd]);

  const toggle = useCallback(() => {
    setGoals(loadGoalRunsSync(cwd));
    setOpen((current) => !current);
  }, [cwd]);

  const run = useCallback(
    (goalRun: GoalRun) => {
      setOpen(false);
      onRunGoal(goalRun);
    },
    [onRunGoal],
  );

  const deleteGoal = useCallback(
    (goalRun: GoalRun) => {
      setOpen(false);
      void (async () => {
        await onDeleteGoalSideEffects(goalRun);
        const nextGoals = (await loadGoalRuns(cwd)).filter(
          (candidate) => candidate.id !== goalRun.id,
        );
        await saveGoalRuns(cwd, nextGoals);
        setGoals(nextGoals);
      })().catch(onError);
    },
    [cwd, onDeleteGoalSideEffects, onError],
  );

  const pause = useCallback(
    (goalRun: GoalRun) => {
      setOpen(false);
      onPauseGoal(goalRun);
    },
    [onPauseGoal],
  );

  return { open, goals, close, openPicker, toggle, run, deleteGoal, pause, refresh };
}
