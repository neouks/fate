"""Check saved real-run evidence. No model calls and no budget gates."""
import collections
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
run = json.loads((root / 'run.json').read_text())
paused = json.loads((root / 'paused-state.json').read_text())
ui = json.loads((root / 'ui-verification.json').read_text())
checks = {}


def check(name, condition):
    checks[name] = bool(condition)


intent = run['intents'][0]
fact_ids = sorted(n['id'] for n in run['facts'])
check('one_planner_intent_completed', len(run['intents']) == 1 and intent['state'] == 'done' and run['task']['status'] == 'done')
check('two_distinct_committed_facts', len(fact_ids) == 2 and len(set(fact_ids)) == 2 and all(n['state'] == 'confirmed' and n['payload']['from_intent'] == intent['id'] for n in run['facts']))
check('fact_visible_during_execution', run['gate']['fact_ids'] == [fact_ids[0]] and any(n['id'] == intent['id'] and n['state'] == 'running' for n in run['first_fact_visible_while_running']['intents']))
check('authorized_independent_read', f'"id":{fact_ids[0]}' in (root / 'live-context.json').read_text())
check('pause_preserves_fact_and_task', len(paused['intents']) == 1 and paused['intents'][0]['state'] == 'paused' and [n['id'] for n in paused['facts']] == [fact_ids[0]] and not paused['task']['paused'] and paused['task']['status'] == 'running')
calls = [m for m in run['mcp'] if m['method'] == 'tools/call']
held = [m for m in calls if m.get('cancelled_at')]
check('real_remote_response_gate_cancelled', len(held) == 1 and held[0]['status'] == 200 and held[0]['remote_response_at'] < held[0]['cancelled_at'])
check('real_mcp_before_and_after_pause', len(held) == 1 and any(m.get('delivered_at', 'z') < held[0]['cancelled_at'] for m in calls) and any(m.get('delivered_at', '') > held[0]['cancelled_at'] for m in calls))
workers = [r for r in run['runs'] if r['role'] == 'worker']
check('one_worker_resumed_once', len(workers) == 2 and workers[0]['stopReason'] == 'aborted' and workers[1]['stopReason'] == 'completed')
session_path = pathlib.Path(run['data_dir']) / f'sessions/exp{run["exp_id"]}-worker-i{intent["id"]}.jsonl'
entries = [json.loads(line) for line in session_path.read_text().splitlines()]
headers = [e for e in entries if e['type'] == 'session']
tool_calls = [c for e in entries for c in e.get('message', {}).get('content', []) if isinstance(c, dict) and c.get('type') == 'toolCall']
check('same_pi_session_without_replayed_writes', len(headers) == 1 and sum(c['name'] == 'record_fact' for c in tool_calls) == 2 and all('human-intervention' not in json.dumps(e) for e in entries))
check('unlimited_role_budgets', all(r['max_turns'] == 0 and r['max_duration_ms'] == 0 for r in run['runs']) and all(r['effective']['max_turns'] == 0 and r['effective']['max_duration_ms'] == 0 for r in run['runtime_configs']))
check('no_wire_output_caps', all(not r['output_limits'] for r in run['requests']))
check('real_model_requests_succeeded', all(r.get('status') == 200 for r in run['requests']))
check('no_wrapup_requests', all(a['purpose'] == 'conversation' for a in run['attempts']))
check('subscription_bound_to_a', len(run['feedback']) == 1 and run['feedback'][0]['main_seg'] == run['main_a'])
check('feedback_after_resource_release', all(e['active_slots'] == [] for e in run['events']))
completed = [e for e in run['events'] if e['metadata']['worker_feedback']['state'] == 'done']
check('one_completion_only_to_a', len(completed) == 1 and completed[0]['mainSeg'] == run['main_a'] and not any(a['main_seg'] == run['main_b'] and a.get('metadata', {}).get('worker_feedback') for a in run['activity']))
check('main_next_turn_recalled_facts', any(a['worker'] == 'main' and a['kind'] == 'text' and all(f'#{n}' in (a['summary'] or '') for n in fact_ids) for a in run['activity']))
check('duplicate_resume_is_noop', json.loads((root / 'duplicate-resume.json').read_text())['duplicate'])
check('old_worker_messages_gone', json.loads((root / 'old-message-rejected.json').read_text())['status'] == 410)
check('ui_buttons_and_isolation', ui['pauseButton'] and ui['pausingDisabled'] and ui['pausedResumeEnabled'] and ui['resumeButton'] and not ui['workerComposer'] and ui['mainBEmpty'] and ui['mainACompletionCardsAfterReload'] == 1)
summary = {
    'passed': all(checks.values()), 'checks': checks, 'run_id': run['run_id'],
    'model': run['runtime_configs'][0]['effective']['model']['model'],
    'model_requests': len(run['requests']), 'requests_by_role': dict(collections.Counter(a['role'] for a in run['attempts'])),
    'observed_tokens': sum(a['usage'].get('totalTokens', 0) for a in run['attempts']),
    'remote_tool_calls': len(calls), 'delivered_remote_tool_calls': sum(bool(c.get('delivered_at')) for c in calls),
    'fact_ids': fact_ids, 'intent_id': intent['id'], 'pi_session_id': headers[0]['id'],
    'test_control': 'One real MCP response was received and held locally until the UI pause aborted delivery. This proves local cancellation/resource release, not termination of work on the remote server.',
    'expected_recovery_errors': 'One locally cancelled MCP delivery; one deferred-tool lookup before rediscovery in the resumed PI session. Rediscovery and the subsequent real MCP call succeeded.',
}
(root / 'verification.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(summary, ensure_ascii=False, indent=2))
sys.exit(0 if summary['passed'] else 1)
