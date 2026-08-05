-- CUPED had a coverage threshold but no on/off switch, so a Metric could not
-- opt out of the adjustment once pre-period covariates existed for it. Null
-- means the engine default (on); Run Start resolves it and freezes the answer
-- on the Run alongside the other variance-reduction knobs.
ALTER TABLE `metrics` ADD `cuped` integer;
