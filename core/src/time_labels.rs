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
    /// None for a rule that isn't valid, which matches nothing (the others still apply).
    pattern: Option<Regex>,
    /// The capture group with the time; none, and the rule still matches lines (to preview
    /// them) but can't label.
    group: Option<usize>,
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
    /// Each log rule that can't be used as given, by index, and why: one that isn't valid
    /// matches nothing, and one without a capture group matches but gives no times. The
    /// other rules still apply.
    pub(crate) problems: Vec<(usize, String)>,
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
                problems: vec![],
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
                    problems: vec![],
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
                    problems: vec![],
                })
            }
            "log" => {
                let mut problems = vec![];
                let mut names = vec![arg.to_string()];
                let mut rules = vec![];
                for (i, line) in lines.enumerate() {
                    let mut fields = line.splitn(3, '\t');
                    let (scale, label, pattern) = (fields.next(), fields.next(), fields.next());
                    let label = index(&mut names, label.unwrap_or(arg));
                    let mut problem =
                        |why: &str| problems.push((i, format!("Rule {}: {why}", i + 1)));
                    let scale = scale
                        .and_then(|s| s.parse::<f64>().ok())
                        .filter(|s| s.is_finite() && *s > 0.);
                    let pattern = match (scale, pattern) {
                        (_, None) => {
                            problem("incomplete.");
                            None
                        }
                        (None, _) => {
                            problem("the time unit must be positive.");
                            None
                        }
                        (_, Some("")) => {
                            problem("needs a pattern.");
                            None
                        }
                        (_, Some(p)) => Regex::new(p).map_err(|e| problem(&e.to_string())).ok(),
                    };
                    let group = pattern.as_ref().and_then(|p| {
                        match p.capture_names().position(|n| n == Some("time")) {
                            Some(g) => Some(g),
                            None if p.captures_len() == 2 => Some(1),
                            // Which is the time isn't known.
                            None if p.captures_len() > 2 => {
                                problem(&format!(
                                    "{} capture groups: make the others (?:…), or name the time's (?<time>…).",
                                    p.captures_len() - 1
                                ));
                                None
                            }
                            None => {
                                problem("needs a capture group for the time.");
                                None
                            }
                        }
                    });
                    rules.push(Rule {
                        pattern,
                        group,
                        scale: scale.unwrap_or(1.),
                        label,
                    });
                }
                Ok(Rules {
                    method: Method::Log(rules),
                    names,
                    problems,
                })
            }
            _ => Err("Unknown labelling method.".into()),
        }
    }
}
/// A log file's data lines: between `data_start` and `data_end` markers at the starts of
/// lines when it has them (as LTX files do), else every line.
#[cfg(test)]
pub(crate) fn data_lines(bytes: &[u8]) -> impl Iterator<Item = &str> {
    data_section(bytes).1.lines()
}
/// The file's line number (from 1) of the data's first line, and the data.
fn data_section(bytes: &[u8]) -> (usize, &str) {
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
    let before = body.as_ptr() as usize - text.as_ptr() as usize;
    (
        1 + text.as_bytes()[..before]
            .iter()
            .filter(|&&b| b == b'\n')
            .count(),
        body,
    )
}

/// Where a log's rules change the label: (seconds, label) in time order, how many lines each
/// rule matched (a line counts for the first rule that matches it), and a preview of each
/// rule's lines (see `preview`).
pub(crate) struct Changes {
    pub(crate) points: Vec<(f64, u16)>,
    pub(crate) matched: Vec<u32>,
    pub(crate) preview: Vec<Preview>,
    /// The log's data lines.
    pub(crate) lines: usize,
    /// Each rule's captures that aren't numbers: how many, and the first.
    pub(crate) unparsed: Vec<(u32, Option<String>)>,
    /// Each rule's earliest and latest time (s), if it gave any.
    pub(crate) range: Vec<Option<(f64, f64)>>,
}
/// How far before a trial's start or after its end a rule's times may run before they look
/// wrong (a log can start a little before the recording, or end a little after).
pub(crate) const BLEED: f64 = 10.;
/// Each rule's times that look wrong for a trial of `duration` s, and why: captures that aren't
/// numbers, or times outside the trial by more than `BLEED` (a wrong unit, say). The labels
/// are still made; these may only look wrong.
pub(crate) fn time_problems(c: &Changes, duration: f64) -> Vec<(usize, String)> {
    let s = |t: f64| {
        if t.abs() >= 10. {
            format!("{t:.0}")
        } else {
            format!("{t:.2}")
        }
    };
    let mut out = vec![];
    for r in 0..c.matched.len() {
        let rule = r + 1;
        if let (n @ 1.., Some(first)) = (c.unparsed[r].0, &c.unparsed[r].1) {
            let many = if n == 1 {
                "time isn't a number"
            } else {
                "times aren't numbers"
            };
            out.push((r, format!("Rule {rule}: {n} {many} (\"{first}\").")));
        } else if let Some((lo, hi)) = c.range[r] {
            if lo < -BLEED || hi > duration + BLEED {
                out.push((
                    r,
                    format!(
                        "Rule {rule}: times run {} to {} s, outside the trial (0 to {} s).",
                        s(lo),
                        s(hi),
                        s(duration)
                    ),
                ));
            }
        }
    }
    out
}
/// One line of the log's preview.
#[derive(Debug, PartialEq)]
pub(crate) struct Preview {
    /// The rule that took the line, and the label it gives (`NONE` for neither).
    pub(crate) rule: u16,
    pub(crate) label: u16,
    /// The file's line number, from 1.
    pub(crate) line: u32,
    pub(crate) kind: Shown,
    /// The line, at most `PREVIEW_CHARS` characters (empty for a gap).
    pub(crate) text: String,
}
#[derive(Debug, PartialEq)]
pub(crate) enum Shown {
    /// A line a rule took, with its time's span (in characters; empty without one).
    Match(u32, u32),
    /// A line none did.
    Other,
    /// Lines left out.
    Gap,
}
const PREVIEW_CHARS: usize = 160;
pub(crate) const NONE: u16 = u16::MAX;
pub(crate) fn log_changes(rules: &[Rule], log: &[u8]) -> Changes {
    let mut points = vec![];
    let mut matched = vec![0; rules.len()];
    let mut unparsed: Vec<(u32, Option<String>)> = vec![(0, None); rules.len()];
    let mut range: Vec<Option<(f64, f64)>> = vec![None; rules.len()];
    let (first, body) = data_section(log);
    let lines: Vec<&str> = body.lines().map(str::trim).collect();
    // The rule that took each line.
    let mut taken = vec![NONE; lines.len()];
    for (i, &line) in lines.iter().enumerate() {
        for (r, rule) in rules.iter().enumerate() {
            if let Some(c) = rule.pattern.as_ref().and_then(|p| p.captures(line)) {
                matched[r] += 1;
                taken[i] = r as u16;
                if let Some(text) = rule.group.and_then(|g| c.get(g)).map(|m| m.as_str().trim()) {
                    match text.parse::<f64>().map(|t| t * rule.scale) {
                        Ok(t) if t.is_finite() => {
                            points.push((t, rule.label));
                            let (lo, hi) = range[r].get_or_insert((t, t));
                            (*lo, *hi) = (lo.min(t), hi.max(t));
                        }
                        _ => {
                            let (n, first) = &mut unparsed[r];
                            *n += 1;
                            first.get_or_insert_with(|| text.chars().take(20).collect());
                        }
                    }
                }
                break;
            }
        }
    }
    // Stable: lines at one time keep their order, so the later one wins.
    points.sort_by(|a, b| a.0.total_cmp(&b.0));
    let preview = preview(rules, &lines, &taken, first);
    Changes {
        points,
        matched,
        preview,
        lines: lines.len(),
        unparsed,
        range,
    }
}
/// The log as the window previews it: for each label, the first two and last lines its rules
/// take, and the last line before the first taken (in the label held before any match), in
/// file order, with a gap wherever lines are left out (before the first and after the last
/// too). With none taken, the first three and last lines that aren't blank.
fn preview(rules: &[Rule], lines: &[&str], taken: &[u16], first: usize) -> Vec<Preview> {
    // Each label's first two and last lines.
    let mut by_label: std::collections::BTreeMap<u16, (Vec<usize>, usize)> = Default::default();
    for (i, &r) in taken.iter().enumerate() {
        if r != NONE {
            let (firsts, last) = by_label.entry(rules[r as usize].label).or_default();
            if firsts.len() < 2 {
                firsts.push(i);
            }
            *last = i;
        }
    }
    let mut picked: Vec<usize> = by_label
        .values()
        .flat_map(|(firsts, last)| firsts.iter().copied().chain([*last]))
        .collect();
    // The last line before the first match, in the label held until then (label 0).
    let mut before = None;
    if let Some(first_taken) = taken.iter().position(|&r| r != NONE) {
        before = (0..first_taken).rev().find(|&i| !lines[i].is_empty());
        picked.extend(before);
    } else {
        let filled: Vec<usize> = (0..lines.len()).filter(|&i| !lines[i].is_empty()).collect();
        picked = filled
            .iter()
            .take(3)
            .chain(filled.last())
            .copied()
            .collect();
    }
    picked.sort_unstable();
    picked.dedup();
    let gap = || Preview {
        rule: NONE,
        label: NONE,
        line: 0,
        kind: Shown::Gap,
        text: String::new(),
    };
    let mut out = vec![];
    let mut next = 0;
    for &i in &picked {
        if i > next {
            out.push(gap());
        }
        next = i + 1;
        let (line, r) = (lines[i], taken[i]);
        let (kind, label) = if r == NONE {
            (Shown::Other, if Some(i) == before { 0 } else { NONE })
        } else {
            let rule = &rules[r as usize];
            let span = rule
                .group
                .and_then(|g| rule.pattern.as_ref()?.captures(line)?.get(g));
            let chars = |at: usize| line[..at].chars().count() as u32;
            let (a, b) = span.map_or((0, 0), |m| (chars(m.start()), chars(m.end())));
            (Shown::Match(a, b), rule.label)
        };
        out.push(Preview {
            rule: r,
            label,
            line: (first + i) as u32,
            kind,
            text: line.chars().take(PREVIEW_CHARS).collect(),
        });
    }
    if !picked.is_empty() && next < lines.len() {
        out.push(gap());
    }
    out
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
        // With several groups, which is the time must be said: by naming it, or by making the
        // others not capture.
        let (r, c) = log("log\tx\n0.5\ton\tttl_(\\d) ([\\d.e]+) 0").unwrap();
        assert!(r.problems[0]
            .1
            .starts_with("Rule 1: 2 capture groups: make the others (?:…)"));
        assert_eq!((c.matched[0], c.points.len()), (2, 0));
        let (r, c) = log("log\tx\n0.5\ton\tttl_(?:\\d) ([\\d.e]+) 0").unwrap();
        assert!(r.problems.is_empty());
        assert_eq!(c.points, [(0.3, 1), (1.5, 1)]);
        // Without a group a rule still matches (for its preview) but can't label.
        let (r, c) = log("log\tx\n1\ton\tttl_4").unwrap();
        assert_eq!(
            r.problems,
            [(0, "Rule 1: needs a capture group for the time.".to_string())]
        );
        assert_eq!((c.matched[0], c.points.len(), c.lines), (4, 0, 6));
        assert_eq!(c.preview[0].kind, Shown::Match(0, 0));
        // A rule that isn't valid matches nothing, and is reported; the others still apply.
        let (r, c) = log("log\tx\n1\ton\t(\n1\toff\t\n1\ton\t^ttl_4 (\\S+) 1$").unwrap();
        assert_eq!(r.problems.len(), 2);
        assert!(r.problems[0].1.starts_with("Rule 1:"));
        assert_eq!(r.problems[1], (1, "Rule 2: needs a pattern.".to_string()));
        assert_eq!(c.matched, [0, 0, 2]);
        assert_eq!(c.points.len(), 2);
    }

    #[test]
    fn the_preview_shows_each_labels_first_two_and_last_lines_with_gaps() {
        let log = "header\ndata_start\na 1\nx\nb 1\na 2\nb 2\na 3\nb 3\nz\na 4\nb 4\ndata_end";
        let shown = |rules: &str| {
            let r = Rules::parse(rules).unwrap();
            let Method::Log(list) = &r.method else {
                panic!("not log rules");
            };
            log_changes(list, log.as_bytes())
                .preview
                .iter()
                .map(|p| match p.kind {
                    Shown::Gap => "…".to_string(),
                    _ if p.label == NONE => format!("{}", p.line),
                    _ => format!("{}:{}", p.line, p.label),
                })
                .collect::<Vec<_>>()
        };
        // Label 1 from `a` lines, 2 from `b`: each one's first two and last, in file order.
        assert_eq!(
            shown("log\t0\n1\t1\t^a (\\d)\n1\t2\t^b (\\d)"),
            ["…", "3:1", "…", "5:2", "6:1", "7:2", "…", "11:1", "12:2"]
        );
        // Two rules giving one label share its lines.
        assert_eq!(
            shown("log\t0\n1\t1\t^a (\\d)\n1\t1\t^b (\\d)"),
            ["…", "3:1", "…", "5:1", "…", "12:1"]
        );
        // With nothing matched, the first three and last lines that aren't blank.
        assert_eq!(shown("log\t0\n1\t1\t("), ["…", "3", "4", "5", "…", "12"]);
        assert_eq!(shown("log\t0"), ["…", "3", "4", "5", "…", "12"]);
        // Lines before the first match: the last of them, in the label held until then.
        let log = "data_start\nh 1\nh 2\na 1\nb 1\ndata_end";
        let r = Rules::parse("log\t0\n1\t1\t^a (\\d)\n1\t2\t^b (\\d)").unwrap();
        let Method::Log(list) = &r.method else {
            panic!("not log rules");
        };
        let p = log_changes(list, log.as_bytes()).preview;
        let kinds: Vec<(&str, u16)> = p
            .iter()
            .map(|p| {
                (
                    if p.kind == Shown::Gap {
                        "…"
                    } else {
                        p.text.as_str()
                    },
                    p.label,
                )
            })
            .collect();
        assert_eq!(kinds, [("…", NONE), ("h 2", 0), ("a 1", 1), ("b 1", 2)]);
        // The data starts on `data_start`'s line, so `a 1` is line 3.
        let (first, _) = data_section(LOG.as_bytes());
        assert_eq!(first, 3);
    }

    #[test]
    fn times_that_arent_numbers_or_run_outside_the_trial_are_reported() {
        let log = "data_start\nt -5 a\nt 20 a\nt x a\nu 3000 b\nu 9 b\nv 105 c\ndata_end";
        let r =
            Rules::parse("log\t0\n1\t1\t^t (\\S+)\n0.001\t2\t^u (\\S+)\n1\t3\t^v (\\S+)").unwrap();
        let Method::Log(list) = &r.method else {
            panic!("not log rules");
        };
        let c = log_changes(list, log.as_bytes());
        assert_eq!(c.unparsed[0], (1, Some("x".into())));
        let (lo, hi) = c.range[1].unwrap();
        assert!((lo - 0.009).abs() < 1e-12 && hi == 3.);
        // In a 100 s trial: `t` has a capture that isn't a number; `u`'s times fit (ms); `v`
        // runs 5 s past the end, within the bleed allowed.
        assert_eq!(
            time_problems(&c, 100.),
            [(0, "Rule 1: 1 time isn't a number (\"x\").".to_string())]
        );
        // In a 2 s trial, `u` runs past the end, and `v` well past it.
        let late = time_problems(&c, 2.);
        assert_eq!(late.len(), 2);
        assert_eq!(
            late[1],
            (
                2,
                "Rule 3: times run 105 to 105 s, outside the trial (0 to 2.00 s).".into()
            )
        );
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
