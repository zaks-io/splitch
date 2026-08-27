-- Ratio Metrics bind two existing same-App non-Ratio Metrics. Historical rows
-- that used the old direct Event Definition shape remain visibly incomplete
-- until an operator supplies both operands; no plausible operand is inferred.
ALTER TABLE `metrics` ADD `numerator_metric_id` text;
