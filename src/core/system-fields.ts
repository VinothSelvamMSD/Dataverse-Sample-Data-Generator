/**
 * Shared system field detection for both AI and Faker generators.
 * These fields should NOT be populated during sample data generation —
 * they are managed by the platform, auto-calculated, or not user-facing.
 */

const EXACT_SYSTEM_FIELDS = new Set([
  // --- Ownership & security ---
  'ownerid', 'owninguser', 'owningteam', 'owningbusinessunit',
  'organizationid', 'parentbusinessunitid',

  // --- Audit/tracking (platform-managed) ---
  'createdon', 'createdby', 'createdonbehalfby',
  'modifiedon', 'modifiedby', 'modifiedonbehalfby',
  'versionnumber', 'overriddencreatedon',

  // --- Import/migration ---
  'importsequencenumber',

  // --- Timezone ---
  'timezoneruleversionnumber',

  // --- Currency (auto-calculated) ---
  'exchangerate', 'transactioncurrencyid',

  // --- BPF (Business Process Flow) ---
  'processid', 'stageid', 'traversedpath',

  // --- SLA ---
  'slaid', 'slainvokedid', 'onholdtime', 'lastonholdtime',

  // --- Entity image ---
  'entityimageid', 'entityimage', 'entityimage_timestamp', 'entityimage_url',

  // --- Merge ---
  'merged', 'masterid',

  // --- Subscription ---
  'subscriptionid',

  // --- Common non-form system fields (present on many entities) ---
  'statecode', 'statuscode',  // State/Status — handled separately
  'numberofchildren',
  'participatesinworkflow',
  'isprivate',
  'followemail',
  'donotbulkemail', 'donotbulkpostalmail',
  'donotfax', 'donotphone', 'donotemail', 'donotpostalmail',
  'donotsendmm',
  'lastusedincampaign',
  'preferredcontactmethodcode',
  'preferredappointmenttimecode',
  'preferredappointmentdaycode',
  'marketingonly',
  'isbackofficecustomer', 'isautocreate',
  'territorycode',

  // --- Knowledge article system fields ---
  'knowledgearticleid', 'isinternal', 'islatestversion', 'isprimary',
  'knowledgearticleviews', 'knowledgearticleviews_date', 'knowledgearticleviews_state',
  'publishstatusid',
  'readyforreview', 'review', 'reviewstate',
  'setcategoryassociations',
  'updatecontent',

  // --- Email/activity system fields ---
  'compressed', 'correlationmethod', 'deliveryattempts',
  'deliveryreceiptrequestedtype', 'isunsafe', 'isworkflowcreated',
  'postponeemailprocessinguntil', 'submittedby', 'baseconversationindexhash',
  'conversationtrackingid', 'inreplyto', 'messageid',
  'parentactivityid', 'sendersaccount', 'sendermailboxid',

  // --- Rollup/calculated internal ---
  'opencount', 'replycount', 'opendeals', 'opendeals_date', 'opendeals_state',
  'openrevenue', 'openrevenue_date', 'openrevenue_state',
  'wondeals', 'wondeals_date', 'wondeals_state',
  'wonrevenue', 'wonrevenue_date', 'wonrevenue_state',
  'lostdeals', 'lostdeals_date', 'lostdeals_state',
  'lostrevenue', 'lostrevenue_date', 'lostrevenue_state',

  // --- Address internal IDs ---
  'address1_addressid', 'address2_addressid', 'address3_addressid',
]);

/**
 * Check if a column name is a system/internal field that should not be populated.
 */
export function isSystemField(name: string): boolean {
  if (EXACT_SYSTEM_FIELDS.has(name)) return true;

  // --- Pattern-based rules ---

  // UTC offset / timezone
  if (name.includes('utcoffset') || name.includes('utcconversion')) return true;
  if (name.includes('timezone')) return true;

  // Yomi (phonetic) fields — Japanese reading aids
  if (name.includes('yomi')) return true;

  // Base currency fields (auto-calculated)
  if (name.endsWith('_base')) return true;

  // Composite/read-only computed fields
  if (name.endsWith('_composite')) return true;

  // Pre-create temp fields
  if (name.includes('precreate')) return true;

  // Attachment ID fields
  if (name.endsWith('attachmentsid')) return true;

  // Address system sub-fields (not on main forms)
  if (name.endsWith('_addresstypecode')) return true;
  if (name.endsWith('_shippingmethodcode')) return true;
  if (name.endsWith('_freighttermscode')) return true;
  if (name.endsWith('_primarycontactname')) return true;
  if (name.endsWith('_addressid')) return true;

  // Aging buckets (auto-calculated)
  if (name.startsWith('aging')) return true;

  // Internal date tracking suffixes (_date, _state for rollup fields)
  if (name.endsWith('_date') || name.endsWith('_state')) {
    // Only if it looks like a rollup tracking field (has a base name that's also a rollup)
    const base = name.replace(/_(date|state)$/, '');
    if (EXACT_SYSTEM_FIELDS.has(base)) return true;
  }

  return false;
}
