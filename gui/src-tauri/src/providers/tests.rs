// allow: SIZE_OK — a flat list of independent Given/When/Then cases for one
// module. Splitting it by concern would produce two files that both have to be
// open to review a single module's coverage, which is worse than one long file.
use super::*;

async fn test_pool() -> SqlitePool {
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(":memory:")
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("open in-memory database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("apply migrations");
    pool
}

fn named(id: &str) -> NewProvider {
    NewProvider {
        id: id.to_string(),
        ..Default::default()
    }
}

fn ids(providers: &[Provider]) -> Vec<&str> {
    providers.iter().map(|p| p.id.as_str()).collect()
}

/// Reads the active rows with raw SQL, so a test can look at the invariant
/// rather than at whatever the module chose to report about it.
async fn active_ids(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_scalar("SELECT id FROM providers WHERE is_active = 1 ORDER BY id")
        .fetch_all(pool)
        .await
        .expect("read active rows")
}

/// Writes straight past the Rust layer, which is how the SQL constraints and
/// triggers are exercised on their own.
async fn raw_insert(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO providers (id) VALUES (?1)")
        .bind(id)
        .execute(pool)
        .await
        .map(|_| ())
}

#[tokio::test]
async fn a_new_provider_takes_the_column_defaults() {
    let pool = test_pool().await;

    let created = create(&pool, named("openai")).await.expect("create");

    assert_eq!(created.label, "");
    assert_eq!(created.vendor, Vendor::Compatible);
    assert_eq!(created.protocol, Protocol::OpenaiChat);
    assert_eq!(created.base_url, "");
    assert_eq!(created.default_model, "");
    assert_eq!(created.models, Vec::<String>::new());
    assert!(!created.is_active, "creating must not activate");
}

#[tokio::test]
async fn models_round_trip_through_json() {
    let pool = test_pool().await;
    let models = vec!["gpt-4o".to_string(), "gpt-4o-mini".to_string()];

    let created = create(
        &pool,
        NewProvider {
            models: Some(models.clone()),
            ..named("openai")
        },
    )
    .await
    .expect("create");

    assert_eq!(created.models, models);
    assert_eq!(get(&pool, "openai").await.expect("get").models, models);

    let stored: String = sqlx::query_scalar("SELECT models FROM providers WHERE id = 'openai'")
        .fetch_one(&pool)
        .await
        .expect("read raw column");
    assert_eq!(
        stored, r#"["gpt-4o","gpt-4o-mini"]"#,
        "the column must hold a JSON array, not a delimited string"
    );
}

/// The coercion this refuses to do. A stored value that is not an array of
/// strings used to become `[]`, which left the reader looking at an empty
/// dropdown with nothing in the log to explain it.
#[tokio::test]
async fn a_stored_model_list_that_is_not_an_array_is_reported_not_coerced() {
    let pool = test_pool().await;
    create(&pool, named("openai")).await.expect("create");

    for corrupt in [
        r#"{"gpt-4o":true}"#,
        r#""gpt-4o""#,
        "gpt-4o",
        "[1, 2]",
        "not json",
    ] {
        sqlx::query("UPDATE providers SET models = ?1 WHERE id = 'openai'")
            .bind(corrupt)
            .execute(&pool)
            .await
            .expect("corrupt the column");

        let result = get(&pool, "openai").await;
        assert!(
            result.is_err(),
            "{corrupt:?} must not decode to an empty model list"
        );
    }
}

#[tokio::test]
async fn the_slug_charset_is_enforced_in_rust() {
    let pool = test_pool().await;

    for bad in [
        "",
        "OpenAI",
        "my provider",
        "my_provider",
        "open.ai",
        "openai/1",
    ] {
        let result = create(&pool, named(bad)).await;
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "{bad:?} must be rejected before it reaches SQL"
        );
    }

    create(&pool, named("self-hosted-llama-2"))
        .await
        .expect("a slug is allowed");
}

/// The same rule, one layer down. This bypasses the Rust validator entirely, so
/// it proves the CHECK is there rather than proving the validator is thorough.
#[tokio::test]
async fn the_slug_charset_is_enforced_in_sql() {
    let pool = test_pool().await;

    for bad in ["", "OpenAI", "my provider", "my_provider"] {
        assert!(
            raw_insert(&pool, bad).await.is_err(),
            "{bad:?} must be rejected by the CHECK constraint"
        );
    }

    raw_insert(&pool, "openai")
        .await
        .expect("a slug is allowed");
}

/// Both enum columns are closed sets, checked in Rust so the message is
/// readable and in SQL so the table cannot hold a value the code cannot parse.
#[tokio::test]
async fn an_unknown_vendor_or_protocol_is_rejected_by_both_layers() {
    let pool = test_pool().await;

    for (column, bad) in [("vendor", "acme"), ("protocol", "grpc")] {
        let sql = format!("INSERT INTO providers (id, {column}) VALUES ('probe', ?1)");
        assert!(
            sqlx::query(&sql).bind(bad).execute(&pool).await.is_err(),
            "{column} {bad:?} must be rejected by the CHECK constraint"
        );
    }

    assert!(matches!(
        Vendor::try_from("acme"),
        Err(AppError::Validation(_))
    ));
    assert!(matches!(
        Protocol::try_from("grpc"),
        Err(AppError::Validation(_))
    ));
}

/// `label` is display-only and its column default is the empty string, so an
/// empty label is a valid state rather than a missing value.
#[tokio::test]
async fn a_provider_with_no_label_reads_back_as_the_empty_default() {
    let pool = test_pool().await;

    let created = create(
        &pool,
        NewProvider {
            label: Some(String::new()),
            ..named("openai")
        },
    )
    .await
    .expect("an empty label is allowed");

    assert_eq!(created.label, "");
}

#[tokio::test]
async fn activating_a_provider_deactivates_the_others() {
    let pool = test_pool().await;
    for id in ["alpha", "beta", "gamma"] {
        create(&pool, named(id)).await.expect("create");
    }

    set_active(&pool, "alpha").await.expect("activate alpha");
    set_active(&pool, "beta").await.expect("activate beta");

    assert_eq!(active_ids(&pool).await, vec!["beta".to_string()]);
    assert_eq!(
        get_active(&pool).await.expect("read").map(|p| p.id),
        Some("beta".to_string())
    );

    // Re-activating the same row must not duplicate it into a second active.
    set_active(&pool, "beta")
        .await
        .expect("activate beta again");
    assert_eq!(active_ids(&pool).await, vec!["beta".to_string()]);
}

/// The invariant belongs to the database, so it has to survive a caller that
/// skips this module. A script, a future command or a bug all end up here.
#[tokio::test]
async fn the_single_active_invariant_holds_for_writes_that_bypass_the_module() {
    let pool = test_pool().await;
    raw_insert(&pool, "alpha").await.expect("insert");
    raw_insert(&pool, "beta").await.expect("insert");

    sqlx::query("UPDATE providers SET is_active = 1 WHERE id = 'alpha'")
        .execute(&pool)
        .await
        .expect("raw update");
    assert_eq!(active_ids(&pool).await, vec!["alpha".to_string()]);

    sqlx::query("UPDATE providers SET is_active = 1 WHERE id = 'beta'")
        .execute(&pool)
        .await
        .expect("raw update");
    assert_eq!(active_ids(&pool).await, vec!["beta".to_string()]);

    // An INSERT cannot be covered by an UPDATE trigger, so this is the write
    // path most likely to smuggle a second active row in.
    sqlx::query("INSERT INTO providers (id, is_active) VALUES ('gamma', 1)")
        .execute(&pool)
        .await
        .expect("raw insert");
    assert_eq!(active_ids(&pool).await, vec!["gamma".to_string()]);
}

#[tokio::test]
async fn deleting_the_active_provider_leaves_nothing_active() {
    let pool = test_pool().await;
    create(&pool, named("alpha")).await.expect("create");
    create(&pool, named("beta")).await.expect("create");
    set_active(&pool, "alpha").await.expect("activate");

    delete(&pool, "alpha").await.expect("delete");

    assert!(get_active(&pool).await.expect("read").is_none());
    assert_eq!(ids(&list(&pool).await.expect("list")), vec!["beta"]);
}

#[tokio::test]
async fn list_is_ordered_by_id_and_repeats_exactly() {
    let pool = test_pool().await;
    for id in ["gamma", "alpha", "beta-2", "beta"] {
        create(&pool, named(id)).await.expect("create");
    }

    let listed = list(&pool).await.expect("list");
    let first = ids(&listed);
    assert_eq!(first, vec!["alpha", "beta", "beta-2", "gamma"]);
    assert_eq!(ids(&list(&pool).await.expect("list")), first);
}

#[tokio::test]
async fn updating_writes_only_the_fields_that_were_provided() {
    let pool = test_pool().await;
    let created = create(
        &pool,
        NewProvider {
            label: Some("OpenAI".to_string()),
            vendor: Some(Vendor::Openai),
            models: Some(vec!["gpt-4o".to_string()]),
            ..named("openai")
        },
    )
    .await
    .expect("create");
    set_active(&pool, "openai").await.expect("activate");

    let patched = update(
        &pool,
        ProviderPatch {
            id: "openai".to_string(),
            base_url: Some("https://api.example.test".to_string()),
            ..Default::default()
        },
    )
    .await
    .expect("patch");

    assert_eq!(patched.base_url, "https://api.example.test");
    assert_eq!(patched.label, created.label);
    assert_eq!(patched.vendor, created.vendor);
    assert_eq!(patched.models, created.models);
    assert!(patched.is_active, "a patch must not move the active flag");
}

/// `None` means "leave it alone". `Some` means "write it", and the two empty
/// values have to be reachable -- otherwise a field can be set but never cleared.
#[tokio::test]
async fn an_explicit_empty_value_clears_a_field() {
    let pool = test_pool().await;
    create(
        &pool,
        NewProvider {
            label: Some("OpenAI".to_string()),
            models: Some(vec!["gpt-4o".to_string()]),
            ..named("openai")
        },
    )
    .await
    .expect("create");

    let cleared = update(
        &pool,
        ProviderPatch {
            id: "openai".to_string(),
            label: Some(String::new()),
            models: Some(Vec::new()),
            ..Default::default()
        },
    )
    .await
    .expect("patch");

    assert_eq!(cleared.label, "");
    assert!(cleared.models.is_empty());
}

#[tokio::test]
async fn a_second_provider_with_the_same_id_is_rejected() {
    let pool = test_pool().await;
    create(&pool, named("openai")).await.expect("create");

    assert!(matches!(
        create(&pool, named("openai")).await,
        Err(AppError::Validation(_))
    ));
    assert_eq!(list(&pool).await.expect("list").len(), 1);
}

#[tokio::test]
async fn operations_on_a_provider_that_does_not_exist_are_reported() {
    let pool = test_pool().await;

    assert!(matches!(
        get(&pool, "ghost").await,
        Err(AppError::NotFound(_))
    ));
    assert!(matches!(
        update(
            &pool,
            ProviderPatch {
                id: "ghost".to_string(),
                ..Default::default()
            }
        )
        .await,
        Err(AppError::NotFound(_))
    ));
    assert!(matches!(
        delete(&pool, "ghost").await,
        Err(AppError::NotFound(_))
    ));
    assert!(matches!(
        set_active(&pool, "ghost").await,
        Err(AppError::NotFound(_))
    ));
}

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

const MIGRATION: &str = include_str!("../../migrations/0005_providers.sql");

/// The exact column shape. This is the test that catches a migration which
/// applied successfully but produced a table the module cannot read -- a
/// renamed or retyped column still migrates cleanly and still returns `ok`.
#[tokio::test]
async fn the_providers_table_has_the_expected_column_shape() {
    let pool = test_pool().await;

    let actual: Vec<(String, String, i64, Option<String>)> = sqlx::query_as(
        "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('providers') ORDER BY cid",
    )
    .fetch_all(&pool)
    .await
    .expect("read column shape");

    let expected: Vec<(String, String, i64, Option<String>)> = vec![
        ("id", "TEXT", 1, None).to_owned(),
        ("label", "TEXT", 1, Some("''".to_string())),
        ("vendor", "TEXT", 1, Some("'compatible'".to_string())),
        ("protocol", "TEXT", 1, Some("'openai_chat'".to_string())),
        ("base_url", "TEXT", 1, Some("''".to_string())),
        ("default_model", "TEXT", 1, Some("''".to_string())),
        ("models", "TEXT", 1, Some("'[]'".to_string())),
        ("is_active", "INTEGER", 1, Some("0".to_string())),
    ]
    .into_iter()
    .map(|(name, ty, notnull, default)| (name.to_string(), ty.to_string(), notnull, default))
    .collect();

    assert_eq!(
        actual, expected,
        "the providers table does not have the shape the module reads"
    );
}

/// The migration must land on a database that already carries the reader's
/// data. Runs the real shipped file, against the real tables from 0001-0006,
/// with rows in them.
#[tokio::test]
async fn the_migration_preserves_rows_written_by_earlier_migrations() {
    let pool = test_pool().await;

    // Roll the table back to the state a build from before this migration left
    // behind, then mark 0005 as never applied.
    sqlx::query("DROP TABLE providers")
        .execute(&pool)
        .await
        .expect("drop the migrated table");
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = 5")
        .execute(&pool)
        .await
        .expect("roll the version back");

    sqlx::query("INSERT INTO documents (id, title) VALUES ('doc-1', 'Kept')")
        .execute(&pool)
        .await
        .expect("seed an 0001 row");
    sqlx::query("INSERT INTO settings (key, value) VALUES ('density', 'roomy')")
        .execute(&pool)
        .await
        .expect("seed a settings row");
    let themes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM custom_themes")
        .fetch_one(&pool)
        .await
        .expect("count curated themes");
    assert_eq!(themes, 12, "0004 and 0006 seed twelve curated themes");

    sqlx::raw_sql(MIGRATION)
        .execute(&pool)
        .await
        .expect("migration 0005 should apply to a populated database");

    let title: String = sqlx::query_scalar("SELECT title FROM documents WHERE id = 'doc-1'")
        .fetch_one(&pool)
        .await
        .expect("0001 row survives");
    assert_eq!(title, "Kept");

    let value: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'density'")
        .fetch_one(&pool)
        .await
        .expect("settings row survives");
    assert_eq!(value, "roomy");

    // And the table it added is usable.
    create(&pool, named("openai")).await.expect("create");
    assert_eq!(list(&pool).await.expect("list").len(), 1);
}

/// `migrate!` is called on every launch and on every test, so a second run has
/// to be a no-op rather than an error. It also pins which migrations the build
/// actually ships: a colliding version number would show up here as a missing or
/// duplicated entry.
#[tokio::test]
async fn applying_the_migrations_twice_changes_nothing() {
    let pool = test_pool().await;
    create(&pool, named("openai")).await.expect("create");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("a second run must be a no-op, not an error");

    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .expect("read applied versions");
    assert_eq!(versions, vec![1, 2, 3, 4, 5]);

    assert_eq!(list(&pool).await.expect("list").len(), 1);
}

/// Seeding is a one-time migration of a setup that already worked. Two properties
/// matter and they pull in opposite directions: it must happen the first time,
/// and it must never happen again.
mod seeding {
    use super::*;
    use crate::providers::{list, seed_from_env, seed_label, Vendor};
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |key: &str| map.get(key).cloned()
    }

    #[tokio::test]
    async fn an_environment_becomes_the_first_provider_and_goes_active() {
        let pool = test_pool().await;
        let seeded = seed_from_env(
            &pool,
            env(&[
                ("OPENAI_API_KEY", "sk-from-env"),
                ("OPENAI_BASE_URL", "https://api.groq.com/openai/v1"),
                ("LLM_MODEL", "openai/gpt-oss-20b"),
            ]),
        )
        .await
        .expect("seed");

        assert!(seeded, "an empty registry with a configured env must seed");
        let providers = list(&pool).await.expect("list");
        assert_eq!(providers.len(), 1);
        let provider = &providers[0];
        assert_eq!(provider.base_url, "https://api.groq.com/openai/v1");
        assert_eq!(provider.default_model, "openai/gpt-oss-20b");
        assert_eq!(provider.vendor, Vendor::Compatible);
        assert!(provider.is_active, "the seeded provider is the active one");
    }

    #[tokio::test]
    async fn seeding_never_runs_twice() {
        let pool = test_pool().await;
        let configured = env(&[("OPENAI_API_KEY", "sk-first"), ("LLM_MODEL", "m1")]);
        assert!(seed_from_env(&pool, configured).await.expect("first"));

        let second = seed_from_env(&pool, env(&[("OPENAI_API_KEY", "sk-second")]))
            .await
            .expect("second");
        assert!(!second, "a non-empty registry must never be re-seeded");

        let providers = list(&pool).await.expect("list");
        assert_eq!(providers.len(), 1, "still exactly one provider");
        assert_eq!(
            providers[0].default_model, "m1",
            "the original value stands"
        );
    }

    #[tokio::test]
    async fn an_empty_environment_seeds_nothing_and_says_so() {
        let pool = test_pool().await;
        let seeded = seed_from_env(&pool, env(&[])).await.expect("seed");
        assert!(!seeded);
        assert!(list(&pool).await.expect("list").is_empty());
    }

    #[tokio::test]
    async fn a_key_without_a_base_url_is_an_openai_provider_not_a_custom_one() {
        let pool = test_pool().await;
        seed_from_env(&pool, env(&[("OPENAI_API_KEY", "sk-plain")]))
            .await
            .expect("seed");
        let providers = list(&pool).await.expect("list");
        assert_eq!(providers[0].vendor, Vendor::Openai);
        assert_eq!(
            providers[0].base_url, "",
            "no endpoint means the vendor default"
        );
    }

    #[test]
    fn the_seeded_label_names_the_host_it_adopted() {
        assert_eq!(seed_label("https://api.groq.com/openai/v1"), "api.groq.com");
        assert_eq!(seed_label("http://localhost:11434/v1"), "localhost:11434");
        assert_eq!(
            seed_label(""),
            "OpenAI",
            "no endpoint falls back to the vendor name"
        );
    }
}

/// The environment owns the provider it seeded, and nothing else. Each case here
/// is a way that ownership can go wrong: reclaimed when it must not be, kept
/// when it must be corrected, or handed to a provider on another host.
mod env_sync {
    use super::*;
    use crate::providers::{clear_key_source, get_active, key_source, mark_key_user_owned};
    use crate::providers::{create, set_active, sync_env_credential, NewProvider};
    use crate::secrets;
    use std::collections::HashMap;

    const GROQ: &str = "https://api.groq.com/openai/v1";

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |key: &str| map.get(key).cloned()
    }

    /// Whether a credential was written, read from the metadata row rather than
    /// from the store: the test credential store keeps a value only inside the
    /// entry that wrote it, so a second entry cannot read the first one's back.
    async fn credential_written(pool: &SqlitePool, id: &str) -> bool {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM secrets_meta WHERE account = ?1")
            .bind(secrets::slot_for(id))
            .fetch_one(pool)
            .await
            .expect("count credential rows");
        count > 0
    }

    /// A provider with its own id and endpoint, active. Ids are distinct per test
    /// because the credential metadata is real even when the pool is not.
    async fn active_provider(pool: &SqlitePool, id: &str, base_url: &str) {
        create(
            pool,
            NewProvider {
                id: id.to_string(),
                base_url: Some(base_url.to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("create provider");
        set_active(pool, id).await.expect("activate provider");
    }

    #[test]
    fn the_same_endpoint_ignores_trailing_slash_and_case() {
        assert!(same_endpoint(GROQ, "https://api.groq.com/openai/v1/"));
        assert!(same_endpoint(
            "HTTPS://API.GROQ.COM/openai/v1",
            "https://api.groq.com/openai/v1"
        ));
        assert!(
            same_endpoint("", ""),
            "both unset means the vendor's own default endpoint"
        );
        assert!(!same_endpoint(GROQ, ""));
        assert!(!same_endpoint("https://api.anthropic.com", GROQ));
    }

    #[tokio::test]
    async fn a_provider_starts_unowned_and_can_be_taken_back() {
        let pool = test_pool().await;
        active_provider(&pool, "ownership", GROQ).await;

        assert_eq!(key_source(&pool, "ownership").await.expect("read"), None);
        mark_key_user_owned(&pool, "ownership").await.expect("mark");
        assert_eq!(
            key_source(&pool, "ownership")
                .await
                .expect("read")
                .as_deref(),
            Some("user")
        );
        clear_key_source(&pool, "ownership").await.expect("clear");
        assert_eq!(
            key_source(&pool, "ownership").await.expect("read"),
            None,
            "deleting the key hands the provider back to the environment"
        );
    }

    /// The failure this whole mechanism exists for: a key corrected in `.env`
    /// used to change nothing, because the registry kept the copy it took at
    /// first launch and never looked at the file again.
    #[tokio::test]
    async fn the_environment_reclaims_the_provider_it_seeded() {
        let pool = test_pool().await;
        active_provider(&pool, "env-owned", GROQ).await;

        let adopted = sync_env_credential(
            &pool,
            env(&[
                ("OPENAI_API_KEY", "gsk-corrected"),
                ("OPENAI_BASE_URL", GROQ),
            ]),
        )
        .await
        .expect("sync");

        assert!(
            adopted,
            "the environment must be able to correct its own key"
        );
        assert!(credential_written(&pool, "env-owned").await);
        assert_eq!(
            key_source(&pool, "env-owned")
                .await
                .expect("read")
                .as_deref(),
            Some("env")
        );
    }

    #[tokio::test]
    async fn a_key_the_reader_set_is_never_taken_back() {
        let pool = test_pool().await;
        active_provider(&pool, "reader-owned", GROQ).await;
        mark_key_user_owned(&pool, "reader-owned")
            .await
            .expect("mark");

        let adopted = sync_env_credential(
            &pool,
            env(&[("OPENAI_API_KEY", "gsk-env"), ("OPENAI_BASE_URL", GROQ)]),
        )
        .await
        .expect("sync");

        assert!(
            !adopted,
            "a key the reader typed outranks the file and must survive the next launch"
        );
        assert!(
            !credential_written(&pool, "reader-owned").await,
            "the environment must not have written anything"
        );
    }

    #[tokio::test]
    async fn a_provider_pointing_elsewhere_never_gets_the_environment_key() {
        let pool = test_pool().await;
        active_provider(&pool, "elsewhere", "https://api.anthropic.com").await;

        let adopted = sync_env_credential(
            &pool,
            env(&[("OPENAI_API_KEY", "gsk-env"), ("OPENAI_BASE_URL", GROQ)]),
        )
        .await
        .expect("sync");

        assert!(
            !adopted,
            "a credential for one host must never be handed to another"
        );
        assert!(!credential_written(&pool, "elsewhere").await);
        assert_eq!(key_source(&pool, "elsewhere").await.expect("read"), None);
    }

    #[tokio::test]
    async fn an_absent_environment_key_changes_nothing() {
        let pool = test_pool().await;
        active_provider(&pool, "no-env", GROQ).await;

        let adopted = sync_env_credential(&pool, env(&[])).await.expect("sync");

        assert!(!adopted);
        assert!(!credential_written(&pool, "no-env").await);
        assert_eq!(key_source(&pool, "no-env").await.expect("read"), None);
    }

    #[tokio::test]
    async fn seeding_marks_the_credential_as_the_environments() {
        let pool = test_pool().await;
        seed_from_env(
            &pool,
            env(&[("OPENAI_API_KEY", "sk-seeded"), ("OPENAI_BASE_URL", GROQ)]),
        )
        .await
        .expect("seed");

        let provider = get_active(&pool)
            .await
            .expect("active")
            .expect("a provider");
        assert_eq!(
            key_source(&pool, &provider.id)
                .await
                .expect("read")
                .as_deref(),
            Some("env"),
            "a seeded credential is the environment's to correct"
        );
    }
}

mod legacy_settings {
    use super::*;
    use crate::providers::migrate_legacy_settings;

    async fn write_settings(pool: &SqlitePool, raw: &str) {
        sqlx::query(
            "INSERT INTO settings (key, value, updated_at) VALUES ('app', ?1, datetime('now'))
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        )
        .bind(raw)
        .execute(pool)
        .await
        .expect("write the settings row");
    }

    async fn read_settings(pool: &SqlitePool) -> serde_json::Value {
        let raw: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app'")
            .fetch_one(pool)
            .await
            .expect("read the settings row");
        serde_json::from_str(&raw).expect("parse the settings row")
    }

    /// What a pre-registry build left behind: the provider, its model and its
    /// endpoint inside the `app` row, next to the settings that still belong
    /// there.
    const LEGACY: &str = r#"{"provider":"Anthropic","model":"claude-3-5-sonnet",
        "endpoint":"https://api.anthropic.com","theme":"night","font":"Newsreader"}"#;

    #[tokio::test]
    async fn an_empty_registry_adopts_the_legacy_triple_and_sheds_the_row() {
        let pool = test_pool().await;
        write_settings(&pool, LEGACY).await;

        assert!(migrate_legacy_settings(&pool).await.expect("migrate"));

        let providers = list(&pool).await.expect("list");
        assert_eq!(ids(&providers), vec!["anthropic"]);
        assert_eq!(providers[0].default_model, "claude-3-5-sonnet");
        assert_eq!(providers[0].base_url, "https://api.anthropic.com");
        assert_eq!(active_ids(&pool).await, vec!["anthropic"]);

        let row = read_settings(&pool).await;
        assert!(row.get("provider").is_none(), "the flat provider is gone");
        assert!(row.get("model").is_none(), "the flat model is gone");
        assert!(row.get("endpoint").is_none(), "the flat endpoint is gone");
        // And the settings that are still settings are untouched.
        assert_eq!(row["theme"], "night");
        assert_eq!(row["font"], "Newsreader");
    }

    #[tokio::test]
    async fn a_populated_registry_keeps_its_provider_and_sheds_the_row() {
        let pool = test_pool().await;
        let existing = create(
            &pool,
            NewProvider {
                id: "compatible".into(),
                base_url: Some("https://api.groq.com/openai/v1".into()),
                default_model: Some("openai/gpt-oss-20b".into()),
                ..Default::default()
            },
        )
        .await
        .expect("create");
        set_active(&pool, &existing.id).await.expect("active");
        write_settings(&pool, LEGACY).await;

        assert!(migrate_legacy_settings(&pool).await.expect("migrate"));

        let providers = list(&pool).await.expect("list");
        assert_eq!(ids(&providers), vec!["compatible"], "no row was invented");
        assert_eq!(
            providers[0].default_model, "openai/gpt-oss-20b",
            "the registry's own model is the newer record and wins"
        );
        assert!(read_settings(&pool).await.get("provider").is_none());
    }

    #[tokio::test]
    async fn a_legacy_model_fills_an_active_provider_that_has_none() {
        let pool = test_pool().await;
        let existing = create(&pool, named("compatible")).await.expect("create");
        set_active(&pool, &existing.id).await.expect("active");
        write_settings(
            &pool,
            r#"{"provider":"OpenAI","model":"gpt-4o","endpoint":""}"#,
        )
        .await;

        assert!(migrate_legacy_settings(&pool).await.expect("migrate"));

        let active = get_active(&pool)
            .await
            .expect("active")
            .expect("a provider");
        assert_eq!(
            active.default_model, "gpt-4o",
            "the reader's last model is not lost to the migration"
        );
    }

    #[tokio::test]
    async fn a_row_without_the_triple_is_left_alone() {
        let pool = test_pool().await;
        write_settings(&pool, r#"{"theme":"night","font":"Georgia"}"#).await;

        assert!(
            !migrate_legacy_settings(&pool).await.expect("migrate"),
            "there is nothing to migrate"
        );
        assert_eq!(read_settings(&pool).await["theme"], "night");
    }

    #[tokio::test]
    async fn running_twice_is_a_no_op() {
        let pool = test_pool().await;
        write_settings(&pool, LEGACY).await;

        assert!(migrate_legacy_settings(&pool).await.expect("first"));
        assert!(
            !migrate_legacy_settings(&pool).await.expect("second"),
            "the second pass has nothing left to strip"
        );
        assert_eq!(ids(&list(&pool).await.expect("list")), vec!["anthropic"]);
    }
}
