/**
 * CoreSkeleton27 -> model bone-name compatibility table for the ARDY 3D rig.
 *
 * CoreSkeleton27 is the official 27-joint MMD-style skeleton ARDY poses with.
 * The canonical protocol names (`rayure.motion.v1`) are the lower-snake
 * anatomical names the companion emits (`right_upper_arm`, `right_elbow`,
 * ...).  A given protocol joint must be resolved onto whatever the loaded
 * model actually names its bones - the official CoreSkin mannequin uses the
 * exact CoreSkeleton27 names (`Hips`, `Spine`, ...), while game-converted PMX
 * models like 阿贝多.pmx mix English `001 R UpperArm`-style bones with
 * Japanese MMD names (`右肩`, `右ひじ`, ...).  This table is the preference
 * order used to resolve one protocol joint to one model bone, so the adapter
 * stays a small self-contained runtime instead of assuming a naming scheme.
 */

/** Official CoreSkeleton27 order (scripts/ardy-bridge.py CORE_JOINT_NAMES). */
export const CORE_JOINT_NAMES: readonly string[] = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Spine3', 'Neck', 'Head',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'RightHandEnd', 'RightHandThumb1',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'LeftHandEnd', 'LeftHandThumb1',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
]

/**
 * Canonical protocol joint name -> CoreSkeleton27 name.  Inverse of
 * ARDY_TO_CANONICAL in apps/companion/src/ardy-motion-adapter.ts; keep in sync.
 */
export const CANONICAL_TO_CORE: Readonly<Record<string, string>> = {
  hips: 'Hips', spine: 'Spine', spine1: 'Spine1', spine2: 'Spine2', spine3: 'Spine3',
  neck: 'Neck', head: 'Head',
  right_shoulder: 'RightShoulder', right_upper_arm: 'RightArm', right_elbow: 'RightForeArm',
  right_wrist: 'RightHand', right_hand_end: 'RightHandEnd', right_thumb: 'RightHandThumb1',
  left_shoulder: 'LeftShoulder', left_upper_arm: 'LeftArm', left_elbow: 'LeftForeArm',
  left_wrist: 'LeftHand', left_hand_end: 'LeftHandEnd', left_thumb: 'LeftHandThumb1',
  right_hip: 'RightUpLeg', right_knee: 'RightLeg', right_ankle: 'RightFoot', right_toe: 'RightToeBase',
  left_hip: 'LeftUpLeg', left_knee: 'LeftLeg', left_ankle: 'LeftFoot', left_toe: 'LeftToeBase',
}

/**
 * Bone names that may stand in for each CoreSkeleton27 joint, in preference
 * order.  The first candidate present on the model wins.  CoreSkeleton27 names
 * come first so the official mannequin resolves trivially; MMD Japanese names
 * and common game-conversion English names follow.
 *
 * `Spine3` deliberately falls back to 上半身3 (classic MMD splits the spine
 * into only three segments; CoreSkeleton27 has four).  Losing one spine
 * segment's rotation is a visual approximation, not a rig error.
 */
export const CORE_BONE_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  Hips: ['Hips', '腰', '下半身', 'Pelvis'],
  Spine: ['Spine', '上半身', 'Chest'],
  Spine1: ['Spine1', '上半身2', 'Chest2'],
  Spine2: ['Spine2', '上半身3'],
  Spine3: ['Spine3', '上半身4', '上半身3'],
  Neck: ['Neck', '首'],
  Head: ['Head', '頭', '頭部'],
  RightShoulder: ['RightShoulder', '右肩', '右肩C', 'shoulderP_R', 'RightClavicle', '001 R Clavicle'],
  RightArm: ['RightArm', '右腕', '001 R UpperArm', 'UpperArm_R', 'RightUpperArm', '右腕捩1'],
  RightForeArm: ['RightForeArm', '右ひじ', '001 R Forearm', 'Forearm_R', 'RightForearm', '右ひじ捩1'],
  RightHand: ['RightHand', '右手首', '001 R Hand', 'Hand_R', 'RightHand'],
  RightHandEnd: ['RightHandEnd', '右手先', '右手'],
  // `001 R/L Finger0` assumes the common game-extraction finger index where
  // Finger0 is the thumb (mihoyo-style PMX exports); thumb-only ARDY joints
  // still resolve onto the base phalanx.
  RightHandThumb1: ['RightHandThumb1', '右親指', 'Thumb_R', '001 R Finger0'],
  LeftShoulder: ['LeftShoulder', '左肩', '左肩C', 'shoulderP_L', 'LeftClavicle', '001 L Clavicle'],
  LeftArm: ['LeftArm', '左腕', '001 L UpperArm', 'UpperArm_L', 'LeftUpperArm', '左腕捩1'],
  LeftForeArm: ['LeftForeArm', '左ひじ', '001 L Forearm', 'Forearm_L', 'LeftForearm', '左ひじ捩1'],
  LeftHand: ['LeftHand', '左手首', '001 L Hand', 'Hand_L', 'LeftHand'],
  LeftHandEnd: ['LeftHandEnd', '左手先', '左手'],
  LeftHandThumb1: ['LeftHandThumb1', '左親指', 'Thumb_L', '001 L Finger0'],
  RightUpLeg: ['RightUpLeg', '右足', 'RightThigh', 'Thigh_R'],
  RightLeg: ['RightLeg', '右ひざ', 'RightLeg', 'Shin_R'],
  RightFoot: ['RightFoot', '右足首', 'RightFoot', 'Ankle_R'],
  RightToeBase: ['RightToeBase', '右つま先', 'RightToe', 'Toe_R'],
  LeftUpLeg: ['LeftUpLeg', '左足', 'LeftThigh', 'Thigh_L'],
  LeftLeg: ['LeftLeg', '左ひざ', 'LeftLeg', 'Shin_L'],
  LeftFoot: ['LeftFoot', '左足首', 'LeftFoot', 'Ankle_L'],
  LeftToeBase: ['LeftToeBase', '左つま先', 'LeftToe', 'Toe_L'],
}
