import { describe, expect, it } from 'vitest'
import { requiredInputsForStep } from '../src/index.ts'

describe('skill confirmation policy', () => {
  it('does not add acquisition or parameter preparation confirmations', () => {
    expect(requiredInputsForStep('acquire_4d_stem', 'agent_sem', 'acquire_4d_stem')).toEqual([])
    expect(requiredInputsForStep('acquire_4d_stem', 'agent_sem', 'wait')).toEqual([])
    expect(requiredInputsForStep('ptychography', 'agent_ptychography', 'prepare_parameters')).toEqual([])
  })
  it('preserves the review gates explicitly declared in current skills', () => {
    expect(requiredInputsForStep('ptychography', 'agent_ptychography', 'append_exp_params')).toContain('confirm_prepared_ptychography_parameters')
    expect(requiredInputsForStep('ptychography', 'agent_ptychography', 'start_server_ptychography')).toContain('confirm_saved_ptychography_parameters_before_server')
    expect(requiredInputsForStep('recommend_4d_stem_parameters', 'agent_suggestion', 'update_parameters')).toContain('recommendation_settings_confirmation')
  })
})
