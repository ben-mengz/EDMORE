import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EdmoreWorkflow } from '../src/index.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('EDMORE workflow recovery', () => {
  it('pauses an in-flight MCP transport failure for verification without advancing the plan', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'edmore-workflow-'))
    temporaryDirectories.push(directory)
    const statePath = join(directory, 'state.json')
    const plan = {
      workflow_id: 'workflow-1',
      session_id: 'session-1',
      prompt: 'start preview',
      status: 'needs_approval',
      goal: 'Start BF preview',
      summary: 'Start preview',
      steps: [{
        step_id: 'step-1',
        agent: 'agent_sem',
        goal: 'Start BF preview',
        skill: 'acquire-4d-stem',
        tool_name: 'play_bf',
        arguments: {},
        required_inputs: [],
        expected_output: 'Preview started',
        on_success: 'continue',
        on_failure: 'pause',
      }],
      user_summary: 'Start preview',
      missing_inputs: [],
      risks: [],
      judge_report: { grounding_status: 'fully_grounded', status: 'pass', summary: 'pass', issues: [] },
      judge_replan_history: [],
    }
    await writeFile(statePath, JSON.stringify({
      version: 1,
      planningProposals: [],
      planningProposalBySession: [],
      pending: [],
      pendingBySession: [],
      activeBySession: [['session-1', { plan, nextStepIndex: 0 }]],
      pausedBySession: [],
      inFlightToolCalls: [],
      instrumentLeases: [],
      archived: [],
    }))
    const events: Array<{ type: string; payload: unknown }> = []
    const workflow = new EdmoreWorkflow({
      async append(event) {
        events.push(event)
        return { event_id: 'event', cursor: events.length, timestamp: new Date().toISOString(), ...event }
      },
    }, {
      async status() { return { ok: true, agents: ['agent_sem'], agentInfo: { agent_sem: { name: 'agent_sem' } }, message: 'ok' } },
      async listTools() { return { tools: [] } },
    }, directory, statePath)
    await workflow.ready()
    workflow.bindHarnessSession('harness-session', 'session-1')

    await workflow.beforeLoopToolCall('harness-session', 'agent_sem', 'play_bf', {}, 'call-1')
    await workflow.handleLoopToolError('harness-session', 'agent_sem', 'play_bf', 'call-1', new Error('connection reset'))

    const state = workflow.state() as {
      active: unknown[]
      paused: Array<{ state: { next_step_index: number; transport_error: boolean; required_inputs: string[] } }>
      instrument_leases: Array<{ state: string }>
    }
    expect(state.active).toHaveLength(0)
    expect(state.paused[0]?.state).toMatchObject({ next_step_index: 0, transport_error: true })
    expect(state.paused[0]?.state.required_inputs).toContain('verify_in_flight_tool_result_after_transport_error')
    expect(state.instrument_leases[0]?.state).toBe('verify_required')
    expect(events.some(event => event.type === 'edmore.workflow.paused')).toBe(true)

    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { pausedBySession: unknown[]; inFlightToolCalls: unknown[] }
    expect(persisted.pausedBySession).toHaveLength(1)
    expect(persisted.inFlightToolCalls).toHaveLength(0)
  })

  it('returns through arbitrarily nested child plans one parent at a time', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'edmore-workflow-'))
    temporaryDirectories.push(directory)
    const statePath = join(directory, 'state.json')
    const makePlan = (workflowId: string, toolName: string, parent_return?: unknown) => ({
      workflow_id: workflowId,
      session_id: 'session-1',
      ...(parent_return === undefined ? {} : { parent_return }),
      prompt: workflowId,
      status: 'needs_approval',
      goal: workflowId,
      summary: workflowId,
      steps: [{
        step_id: `${workflowId}-step`, agent: 'agent_sem', goal: workflowId,
        skill: 'acquire-4d-stem', tool_name: toolName, arguments: {}, required_inputs: [],
        expected_output: 'ok', on_success: 'done', on_failure: 'pause',
      }],
      user_summary: workflowId,
      missing_inputs: [],
      risks: [],
      judge_report: { grounding_status: 'fully_grounded', status: 'pass', summary: 'pass', issues: [] },
      judge_replan_history: [],
    })
    const root = makePlan('root', 'root_tool')
    const middleReturn = { workflow_id: 'root', session_id: 'session-1', plan: root, next_step_index: 0, reason: 'root paused' }
    const middle = makePlan('middle', 'middle_tool', middleReturn)
    const deepestReturn = { workflow_id: 'middle', session_id: 'session-1', plan: middle, next_step_index: 0, reason: 'middle paused' }
    const deepest = makePlan('deepest', 'deepest_tool', deepestReturn)
    await writeFile(statePath, JSON.stringify({
      version: 1,
      planningProposals: [], planningProposalBySession: [], pending: [], pendingBySession: [],
      activeBySession: [['session-1', { plan: deepest, nextStepIndex: 0 }]],
      pausedBySession: [], inFlightToolCalls: [], instrumentLeases: [], archived: [],
    }))
    const workflow = new EdmoreWorkflow({
      async append(event) { return { event_id: 'event', cursor: 1, timestamp: new Date().toISOString(), ...event } },
    }, {
      async status() { return { ok: true, agents: ['agent_sem'], agentInfo: { agent_sem: { name: 'agent_sem' } }, message: 'ok' } },
      async listTools() { return { tools: [] } },
    }, directory, statePath)
    await workflow.ready()
    workflow.bindHarnessSession('harness-session', 'session-1')

    await workflow.beforeLoopToolCall('harness-session', 'agent_sem', 'deepest_tool', {}, 'call-deepest')
    await workflow.afterLoopToolResult('harness-session', 'agent_sem', 'deepest_tool', 'call-deepest', { content: [{ type: 'text', text: 'ok' }] })
    expect((workflow.state() as { active: Array<{ workflow_id: string }> }).active[0]?.workflow_id).toBe('middle')
    expect(workflow.nextLoopDispatch('session-1')?.workflowId).toBe('middle')
    expect(workflow.nextLoopDispatch('session-1')?.step.tool_name).toBe('middle_tool')

    await workflow.beforeLoopToolCall('harness-session', 'agent_sem', 'middle_tool', {}, 'call-middle')
    await workflow.afterLoopToolResult('harness-session', 'agent_sem', 'middle_tool', 'call-middle', { content: [{ type: 'text', text: 'ok' }] })
    expect((workflow.state() as { active: Array<{ workflow_id: string }> }).active[0]?.workflow_id).toBe('root')
    expect(workflow.nextLoopDispatch('session-1')?.step.tool_name).toBe('root_tool')
  })
})
