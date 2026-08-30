pub(crate) fn expected_compose_frames(start_hns: i64, end_hns: i64, fps: u32) -> u32 {
    if end_hns <= 0 || end_hns == i64::MAX || end_hns <= start_hns {
        return 0;
    }
    let ms = (end_hns - start_hns.max(0)) / 10_000;
    ((ms.saturating_mul(i64::from(fps))) / 1_000).clamp(1, i64::from(u32::MAX)) as u32
}

#[cfg(test)]
mod tests {
    use super::expected_compose_frames;

    #[test]
    fn expected_compose_frames_from_duration() {
        assert_eq!(expected_compose_frames(0, 10_000_000, 60), 60);
        assert_eq!(expected_compose_frames(0, 180_000 * 10_000, 60), 10_800);
        assert_eq!(expected_compose_frames(0, 0, 60), 0);
    }
}
