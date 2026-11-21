//! Time labels: a label for every moment of a trial, from rules, and the times a selection of
//! labels covers.
//!
//! The rules are one text input (see `Rules::parse`): the trial split into equal sections,
//! each with its label; labels from times given one by one; or rules matched against a log
//! file's lines in order, the first that matches a line giving the label from the time it
//! captures. A label holds until the next change, so the trial becomes contiguous segments,
//! each with one label.
use regex_lite::Regex;

/// One log rule: lines it matches set `label` from the time its capture gives.
pub(crate) struct Rule {
    pattern: Regex,
    /// The capture group with the time.
    group: usize,
    /// Seconds per unit of the captured time.
    scale: f64,
    label: u16,
}

/// What labels a trial's time: how, and the labels' names.
pub(crate) enum Method {
    /// No labels: the whole trial is one segment.
    Off,
    /// Equal sections, each with its label.
    Split(Vec<u16>),
    /// Labels from times (s), in order; the first label holds from the start.
    Times(Vec<(f64, u16)>),
    /// Log rules, in order; the trial starts with label 0.
    Log(Vec<Rule>),
}
/// `label`'s index in `names`, added if it isn't there.
fn index(names: &mut Vec<String>, label: &str) -> u16 {
    match names.iter().position(|n| n == label) {
        Some(i) => i as u16,
        None => {
            names.push(label.into());
            (names.len() - 1) as u16
        }
    }
}
pub(crate) struct Rules {
    pub(crate) method: Method,
    /// Label names, in the order rules first give them (the initial label first).
    pub(crate) names: Vec<String>,
}
impl Rules {
    /// Parses the rules' text input: empty for none; `split\t<n>` followed by each section's
    /// label on a line; `times` followed by a line per change, `<seconds>\t<label>`, in order
    /// (the first label holds from the start); or `log\t<initial label>` followed by a line
    /// per rule, `<seconds per unit>\t<label>\t<pattern>`: a regular expression that can
    /// match anywhere in a line, its time in the group named `time` or else the first. An error names
    /// the time or rule (from 1) it is about.
    pub(crate) fn parse(text: &str) -> Result<Rules, String> {
        let mut lines = text.lines();
        let Some(head) = lines.next().filter(|l| !l.is_empty()) else {
            return Ok(Rules {
                method: Method::Off,
                names: vec!["all".into()],
            });
        };
        let (kind, arg) = head.split_once('\t').unwrap_or((head, ""));
        match kind {
            "split" => {
                let n = arg
                    .parse::<usize>()
                    .ok()
                    .filter(|n| (1..=100).contains(n))
                    .ok_or("Sections must be 1 to 100.")?;
                let mut names = vec![];
                let labels: Vec<u16> = lines.map(|l| index(&mut names, l)).collect();
                if labels.len() != n {
                    return Err("Each section needs a label.".into());
                }
                Ok(Rules {
                    method: Method::Split(labels),
                    names,
                })
            }
            "times" => {
                let mut names = vec![];
                let mut times: Vec<(f64, u16)> = vec![];
                for (i, line) in lines.enumerate() {
                    let fail = |why: &str| format!("Time {}: {why}", i + 1);
                    let (time, label) = line.split_once('\t').ok_or_else(|| fail("incomplete."))?;
                    let time = time
                        .parse::<f64>()
                        .ok()
                        .filter(|t| t.is_finite())
                        .ok_or_else(|| fail("not a number."))?;
                    if times.last().is_some_and(|&(last, _)| time < last) {
                        return Err(fail("before the time above it."));
                    }
                    times.push((time, index(&mut names, label)));
                }
                if times.is_empty() {
                    return Err("Add a time.".into());
                }
                Ok(Rules {
                    method: Method::Times(times),
                    names,
                })
            }
            "log" => {
                let mut names = vec![arg.to_string()];
                let mut rules = vec![];
                for (i, line) in lines.enumerate() {
                    let fail = |why: &str| format!("Rule {}: {why}", i + 1);
                    let mut fields = line.splitn(3, '\t');
                    let (Some(scale), Some(label), Some(pattern)) =
                        (fields.next(), fields.next(), fields.next())
                    else {
                        return Err(fail("incomplete."));
                    };
                    let scale = scale
                        .parse::<f64>()
                        .ok()
                        .filter(|s| s.is_finite() && *s > 0.)
                        .ok_or_else(|| fail("the time unit must be positive."))?;
                    if pattern.is_empty() {
                        return Err(fail("needs a pattern."));
                    }
                    let pattern = Regex::new(pattern).map_err(|e| fail(&e.to_string()))?;
                    let group = match pattern.capture_names().position(|n| n == Some("time")) {
                        Some(g) => g,
                        None if pattern.captures_len() > 1 => 1,
                        None => return Err(fail("needs a capture group for the time.")),
                    };
                    let label = index(&mut names, label);
                    rules.push(Rule {
                        pattern,
                        group,
                        scale,
                        label,
                    });
                }
                Ok(Rules {
                    method: Method::Log(rules),
                    names,
                })
            }
            _ => Err("Unknown labelling method.".into()),
        }
    }
}
/// A log file's data lines: between `data_start` and `data_end` markers at the starts of
/// lines when it has them (as LTX files do), else every line.
pub(crate) fn data_lines(bytes: &[u8]) -> impl Iterator<Item = &str> {
    let text = std::str::from_utf8(bytes).unwrap_or_else(|e| {
        // Logs are text; whatever follows bytes that aren't isn't read.
        std::str::from_utf8(&bytes[..e.valid_up_to()]).unwrap()
    });
    let at_line_start = |marker: &str| {
        text.match_indices(marker)
            .find(|&(i, _)| i == 0 || text.as_bytes()[i - 1] == b'\n')
            .map(|(i, _)| i)
    };
    let body = match at_line_start("data_start") {
        Some(i) => {
            let rest = &text[i + "data_start".len()..];
            let end = rest
                .match_indices("data_end")
                .find(|&(j, _)| j == 0 || rest.as_bytes()[j - 1] == b'\n')
                .map_or(rest.len(), |(j, _)| j);
            &rest[..end]
        }
        None => text,
    };
    body.lines()
}

/// Where a log's rules change the label: (seconds, label) in time order, and how many lines
/// each rule matched (a line counts for the first rule that matches it).
pub(crate) struct Changes {
    pub(crate) points: Vec<(f64, u16)>,
    pub(crate) matched: Vec<u32>,
}
pub(crate) fn log_changes(rules: &[Rule], log: &[u8]) -> Changes {
    let mut points = vec![];
    let mut matched = vec![0; rules.len()];
    for line in data_lines(log) {
        let line = line.trim();
        for (r, rule) in rules.iter().enumerate() {
            if let Some(c) = rule.pattern.captures(line) {
                matched[r] += 1;
                let time = c
                    .get(rule.group)
                    .and_then(|m| m.as_str().trim().parse::<f64>().ok());
                if let Some(t) = time.map(|t| t * rule.scale).filter(|t| t.is_finite()) {
                    points.push((t, rule.label));
                }
                break;
            }
        }
    }
    // Stable: lines at one time keep their order, so the later one wins.
    points.sort_by(|a, b| a.0.total_cmp(&b.0));
    Changes { points, matched }
}

/// Contiguous segments covering 0 to `duration` s: each (start, end, label), no two
/// neighbours with one label. The trial starts with `initial`; each change from then sets the
/// label (changes at or before 0 set the initial one, and those at or after the end are
/// outside the trial).
pub(crate) fn segments(
    initial: u16,
    changes: &[(f64, u16)],
    duration: f64,
) -> Vec<(f64, f64, u16)> {
    /// Ends the segment from `start` at `end`, extending the last if it has the same label.
    fn close(out: &mut Vec<(f64, f64, u16)>, start: f64, end: f64, label: u16) {
        match out.last_mut() {
            Some(last) if last.2 == label => last.1 = end,
            _ => out.push((start, end, label)),
        }
    }
    let mut out = vec![];
    let (mut start, mut label) = (0., initial);
    for &(t, next) in changes {
        if t >= duration {
            break;
        }
        if t > start && next != label {
            close(&mut out, start, t, label);
            start = t;
        }
        label = next;
    }
    if duration > start {
        close(&mut out, start, duration, label);
    }
    out
}
/// Equal sections of `duration`, one per label (neighbours with one label as one segment).
pub(crate) fn split(labels: &[u16], duration: f64) -> Vec<(f64, f64, u16)> {
    let n = labels.len() as f64;
    let changes: Vec<(f64, u16)> = (1..labels.len())
        .map(|i| (duration * i as f64 / n, labels[i]))
        .collect();
    labels
        .first()
        .map_or(vec![], |&first| segments(first, &changes, duration))
}
/// Each label's total seconds and number of segments.
pub(crate) fn label_stats(segments: &[(f64, f64, u16)], labels: usize) -> (Vec<f64>, Vec<u32>) {
    let (mut seconds, mut counts) = (vec![0.; labels], vec![0; labels]);
    for &(a, b, l) in segments {
        seconds[l as usize] += b - a;
        counts[l as usize] += 1;
    }
    (seconds, counts)
}
/// The times covered by segments whose label `selected` says, as merged (start, end)
/// intervals.
pub(crate) fn mask(segments: &[(f64, f64, u16)], selected: impl Fn(u16) -> bool) -> Vec<[f64; 2]> {
    let mut out: Vec<[f64; 2]> = vec![];
    for &(a, b, l) in segments {
        if !selected(l) {
            continue;
        }
        match out.last_mut() {
            Some(last) if last[1] >= a => last[1] = b,
            _ => out.push([a, b]),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOG: &str = "trial_date Wednesday\nduration 4   \ndata_startttl_4 0.5 1\nttl_4 0.6 0\nttl_2 1.0 1\nttl_4 2 1\nttl_4 3e0 0\n\ndata_end";

    fn log(rules: &str) -> Result<(Rules, Changes), String> {
        let r = Rules::parse(rules)?;
        let Method::Log(list) = &r.method else {
            panic!("not log rules");
        };
        let c = log_changes(list, LOG.as_bytes());
        Ok((r, c))
    }

    #[test]
    fn rules_match_lines_and_take_the_time_from_a_group() {
        let (r, c) =
            log("log\toff\n1\ton\t^ttl_4 ([\\d.e]+) 1$\n1\toff\t^ttl_4 ([\\d.e]+) 0$").unwrap();
        assert_eq!(r.names, ["off", "on"]);
        assert_eq!(c.matched, [2, 2]);
        assert_eq!(c.points, [(0.5, 1), (0.6, 0), (2., 1), (3., 0)]);
        // A catch-all takes the reward line too; `duration 4` is header, not data.
        let (_, c) = log("log\tx\n1\ty\t^\\S+ (\\S+)").unwrap();
        assert_eq!(c.matched, [5]);
    }

    #[test]
    fn rules_apply_in_order_so_a_later_catch_all_takes_only_the_rest() {
        let (r, c) = log("log\tx\n1\treward\t^ttl_2 (\\S+) 1$\n1\tother\t^\\S+ (\\S+)").unwrap();
        assert_eq!(r.names, ["x", "reward", "other"]);
        assert_eq!(c.matched, [1, 4]);
    }

    #[test]
    fn the_time_is_the_named_or_first_group_and_units_scale_it() {
        let (_, c) = log("log\tx\n0.001\ton\t^ttl_4 (?P<time>[\\d.]+) 1$").unwrap();
        assert_eq!(c.points, [(0.0005, 1), (0.002, 1)]);
        let (_, c) = log("log\tx\n0.001\ton\t^ttl_(\\d) (?<time>[\\d.]+) 1$").unwrap();
        assert_eq!(c.points, [(0.0005, 1), (0.001, 1), (0.002, 1)]);
        let (_, c) = log("log\tx\n0.5\ton\tttl_(\\d) ([\\d.e]+) 0").unwrap();
        // Group 1 is the channel: 4 → 2 s, twice.
        assert_eq!(c.points, [(2., 1), (2., 1)]);
        assert!(log("log\tx\n1\ton\tttl_4")
            .err()
            .unwrap()
            .contains("capture group"));
        assert!(log("log\tx\n1\ton\t(")
            .err()
            .unwrap()
            .starts_with("Rule 1:"));
        assert!(log("log\tx\n1\ton\t").err().unwrap().contains("pattern"));
    }

    #[test]
    fn segments_cover_the_trial_and_merge_repeated_labels() {
        let s = segments(0, &[(0.5, 1), (0.6, 0), (0.6, 0), (2., 1), (3., 0)], 4.);
        assert_eq!(
            s,
            [
                (0., 0.5, 0),
                (0.5, 0.6, 1),
                (0.6, 2., 0),
                (2., 3., 1),
                (3., 4., 0)
            ]
        );
        // Changes before the start set the first label; those after the end don't count.
        assert_eq!(segments(0, &[(-1., 1), (5., 0)], 4.), [(0., 4., 1)]);
        // Two changes at one instant: the later wins, with no empty segment.
        assert_eq!(segments(0, &[(1., 1), (1., 0)], 2.), [(0., 2., 0)]);
        let (seconds, counts) = label_stats(&s, 2);
        assert!((seconds[0] - 2.9).abs() < 1e-9 && (seconds[1] - 1.1).abs() < 1e-9);
        assert_eq!(counts, [3, 2]);
    }

    #[test]
    fn splits_are_equal_and_masks_merge_neighbours() {
        let s = split(&[0, 1, 2, 3], 8.);
        assert_eq!(s, [(0., 2., 0), (2., 4., 1), (4., 6., 2), (6., 8., 3)]);
        assert_eq!(mask(&s, |l| l != 2), [[0., 4.], [6., 8.]]);
        assert_eq!(mask(&s, |_| false), Vec::<[f64; 2]>::new());
        // Neighbouring sections with one label are one segment.
        assert_eq!(split(&[0, 1, 1, 1], 8.), [(0., 2., 0), (2., 8., 1)]);
        assert_eq!(split(&[0, 1, 0, 1], 8.).len(), 4);
        let r = Rules::parse("split\t4\n0\n1\n0\n1").unwrap();
        assert_eq!(r.names, ["0", "1"]);
        assert!(matches!(r.method, Method::Split(ref l) if l == &[0, 1, 0, 1]));
        assert!(Rules::parse("split\t0").is_err());
        assert!(Rules::parse("split\t3\na\nb")
            .err()
            .unwrap()
            .contains("label"));
        assert!(matches!(Rules::parse("").unwrap().method, Method::Off));
    }

    #[test]
    fn custom_times_are_in_order_and_the_first_label_holds_from_the_start() {
        let r = Rules::parse("times\n0\tbase\n60\tdrug\n90.5\twash\n120\tdrug").unwrap();
        assert_eq!(r.names, ["base", "drug", "wash"]);
        let Method::Times(times) = r.method else {
            panic!("not times");
        };
        assert_eq!(times, [(0., 0), (60., 1), (90.5, 2), (120., 1)]);
        // Equal times are allowed (the later wins); going back isn't.
        assert!(Rules::parse("times\n0\ta\n5\tb\n5\tc").is_ok());
        let e = Rules::parse("times\n0\ta\n5\tb\n4\tc").err().unwrap();
        assert_eq!(e, "Time 3: before the time above it.");
        assert!(Rules::parse("times\n0\ta\nx\tb")
            .err()
            .unwrap()
            .contains("number"));
        assert_eq!(Rules::parse("times").err().unwrap(), "Add a time.");
    }

    #[test]
    fn logs_without_markers_are_read_whole() {
        let lines: Vec<&str> = data_lines(b"a 1\r\nb 2\n").collect();
        assert_eq!(lines, ["a 1", "b 2"]);
        let lines: Vec<&str> = data_lines(LOG.as_bytes()).collect();
        assert_eq!(lines.first(), Some(&"ttl_4 0.5 1"));
        assert_eq!(lines.last(), Some(&""));
    }
}
