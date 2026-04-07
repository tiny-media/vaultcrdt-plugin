use proptest::prelude::*;

use crate::document::SyncDocument;

proptest! {
    #![proptest_config(proptest::test_runner::Config::with_cases(10_000))]

    #[test]
    fn prop_concurrent_edits_converge(
        text_a in "[a-z ]{0,50}",
        text_b in "[a-z ]{0,50}",
    ) {
        let mut peer_a = SyncDocument::new("prop-test-doc", "peer-a");
        let mut peer_b = SyncDocument::new("prop-test-doc", "peer-b");

        peer_a.insert_text(0, &text_a).unwrap();
        peer_b.insert_text(0, &text_b).unwrap();

        let delta_a = peer_a.export_delta().unwrap();
        let delta_b = peer_b.export_delta().unwrap();

        peer_a.import_delta(&delta_b).unwrap();
        peer_b.import_delta(&delta_a).unwrap();

        prop_assert_eq!(peer_a.get_text(), peer_b.get_text());
    }
}
