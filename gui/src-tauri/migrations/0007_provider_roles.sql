-- The model a provider uses for thinking and for writing.
--
-- Empty means "same as the provider's selected model", which is the default
-- and the behaviour a reader expects after choosing one model. A reader who
-- wants a reasoning model and a prose model can name them here; the GUI reads
-- these two fields and passes them to Agent unchanged.
ALTER TABLE providers ADD COLUMN thinking_model TEXT NOT NULL DEFAULT '';
ALTER TABLE providers ADD COLUMN writing_model TEXT NOT NULL DEFAULT '';
