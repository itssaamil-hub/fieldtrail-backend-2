# Task workflow

Migration `043_task_workflow.sql` runs through the existing `npm start` migration step. Existing tasks retain their content, assignment and deadlines; their priority defaults to medium and recurrence to none. Deploy the backend before the frontend.

## Behaviour

- Existing `pending` tasks are labelled **To do**. Active work can move between To do and In progress. Both count as pending and receive existing daily task reminders. Completion retains the existing completion-note endpoint.
- Search, employee, priority, progress and inclusive IST due-date range filters run on the server before pagination. Existing All, Today, Overdue, Upcoming and Completed views remain available.
- Admins can manage all tasks. Employees can see, progress, reschedule and complete only tasks assigned to them. They can edit priority/repeat settings or delete only self-created tasks. Existing lead-owner validation is retained.
- The task creation form can search up to 50 assigned leads at a time. Searching narrows the list. Lead details open via the existing authenticated lead route.
- Rescheduling requires a nonblank reason. Task history records actor, old deadline, new deadline, reason and time. A completed task cannot be rescheduled or reopened.

## Recurrence

Daily, weekly and monthly repeats create one successor **on completion**. This does not require another cron job. The next due date is the first future occurrence on the task's cadence, preserving IST time. Missed occurrences are skipped. Monthly repeats preserve the original day-of-month, using the final day in shorter months. Rescheduling establishes the new due date/day for subsequent repeats.

The parent task is locked during completion; a unique `repeat_of` index prevents duplicate successors. Completion, history, successor and notification writes are transactional. Inactive assignees do not receive new occurrences. If the linked lead has moved to another employee, the new task retains its assignee but omits that stale lead link.

Admins, or the employee who created their own task, can set Repeat to Does not repeat on an unfinished occurrence. Deleting an unfinished occurrence also stops future generation. Deleting a completed occurrence does not delete an existing successor. History shows the latest 100 changes per task.

## Validation

Run `node --test test/tasks.test.js test/task-workflow.test.js test/salesmanBrief.test.js test/notificationReadState.test.js`.

The route tests use a mocked database to check authorization, validation, transaction calls, completion idempotence and recurrence generation. They are not a substitute for verifying migration application against the deployed database.
