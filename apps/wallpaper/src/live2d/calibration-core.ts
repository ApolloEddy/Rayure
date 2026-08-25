import type { Live2dCalibrationDescriptor } from '@rayure/protocol'

import type {
  Live2dControl,
  Live2dNeutralPose,
  Live2dParameterBinding,
  Live2dRigProfile,
} from './rig-profile.ts'
import {
  LIVE2D_CONTROL_VALUES,
} from './rig-profile.ts'

export interface CalibrationChannelState {
  control: Live2dControl
  mapped: boolean
  disabled: boolean
  binding?: Live2dParameterBinding
}

/** All ARDY controls in the fixed channel order used by the wizard. */
export function allCalibrationChannels(): readonly Live2dControl[] {
  return LIVE2D_CONTROL_VALUES
}

/** Classify every channel against a profile plus the wizard's disable list. */
export function classifyCalibrationChannels(
  profile: Live2dRigProfile,
  disabledControls: readonly string[],
): readonly CalibrationChannelState[] {
  const disabled = new Set(disabledControls)
  const byControl = new Map<Live2dControl, Live2dParameterBinding>()
  for (const binding of profile.parameters) {
    byControl.set(binding.control, binding)
  }
  return LIVE2D_CONTROL_VALUES.map(control => {
    const binding = byControl.get(control)
    return {
      control,
      mapped: binding !== undefined,
      disabled: disabled.has(control),
      ...(binding === undefined ? {} : { binding }),
    }
  })
}

export function missingCalibrationControls(
  profile: Live2dRigProfile,
  disabledControls: readonly string[] = [],
): readonly Live2dControl[] {
  return classifyCalibrationChannels(profile, disabledControls)
    .filter(channel => !channel.mapped && !channel.disabled)
    .map(channel => channel.control)
}

/**
 * Serializes a wizard rig profile into the wire calibration descriptor.
 * The neutral pose is included verbatim; disabled controls are recorded so
 * they survive the round trip through the strict protocol validator.
 */
export function serializeCalibration(
  profile: Live2dRigProfile,
  disabledControls: readonly string[],
  neutralPose: Live2dNeutralPose | undefined,
): Live2dCalibrationDescriptor {
  return {
    profileId: profile.id,
    parameters: profile.parameters.map(binding => ({
      parameterId: binding.parameterId,
      control: binding.control,
      min: binding.min,
      max: binding.max,
      neutral: binding.neutral,
      ...(binding.scale === undefined ? {} : { scale: binding.scale }),
      ...(binding.invert === undefined ? {} : { invert: binding.invert }),
      ...(binding.mode === undefined ? {} : { mode: binding.mode }),
    })),
    ...(disabledControls.length === 0 ? {} : { disabledControls: [...disabledControls] }),
    ...(neutralPose === undefined ? {} : { neutralPose }),
  }
}
