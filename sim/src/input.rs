//! Canonical input decoding (plan 6.11 byte layout).

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    Join { player: u32 },
    Leave { player: u32 },
    Pos { player: u32, life: u16, x: i32, y: i32, facing: u8 },
    Cast { player: u32, spell: u8, angle: u16, cast_seq: u16 },
    Paint { player: u32, mat: u8, x0: i16, y0: i16, x1: i16, y1: i16, radius: u8 },
}

struct R<'a>(&'a [u8], usize);
impl R<'_> {
    fn take<const N: usize>(&mut self) -> [u8; N] {
        let mut a = [0u8; N];
        a.copy_from_slice(&self.0[self.1..self.1 + N]);
        self.1 += N;
        a
    }
    fn u8(&mut self) -> u8 {
        self.take::<1>()[0]
    }
    fn u16(&mut self) -> u16 {
        u16::from_le_bytes(self.take())
    }
    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.take())
    }
    fn i16(&mut self) -> i16 {
        i16::from_le_bytes(self.take())
    }
    fn i32(&mut self) -> i32 {
        i32::from_le_bytes(self.take())
    }
}

/// Decode one input; `Err` for unknown kind or wrong length.
pub fn decode(b: &[u8]) -> Result<Input, ()> {
    let want = match b.first() {
        Some(1) | Some(2) => 5,
        Some(3) => 16,
        Some(4) => 10,
        Some(5) => 15,
        _ => return Err(()),
    };
    if b.len() != want {
        return Err(());
    }
    let mut r = R(b, 1);
    let kind = b[0];
    let player = {
        r.1 = 1;
        r.u32()
    };
    Ok(match kind {
        1 => Input::Join { player },
        2 => Input::Leave { player },
        3 => Input::Pos { player, life: r.u16(), x: r.i32(), y: r.i32(), facing: r.u8() },
        4 => Input::Cast { player, spell: r.u8(), angle: r.u16(), cast_seq: r.u16() },
        _ => Input::Paint {
            player,
            mat: r.u8(),
            x0: r.i16(),
            y0: r.i16(),
            x1: r.i16(),
            y1: r.i16(),
            radius: r.u8(),
        },
    })
}

pub fn encode_paint(player: u32, mat: u8, x0: i16, y0: i16, x1: i16, y1: i16, radius: u8) -> Vec<u8> {
    let mut v = vec![5];
    v.extend_from_slice(&player.to_le_bytes());
    v.push(mat);
    for n in [x0, y0, x1, y1] {
        v.extend_from_slice(&n.to_le_bytes());
    }
    v.push(radius);
    v
}

pub fn encode_join(player: u32) -> Vec<u8> {
    let mut v = vec![1];
    v.extend_from_slice(&player.to_le_bytes());
    v
}

pub fn encode_leave(player: u32) -> Vec<u8> {
    let mut v = encode_join(player);
    v[0] = 2;
    v
}

/// `x`, `y` in 1/16 cell.
pub fn encode_pos(player: u32, life: u16, x: i32, y: i32, facing: u8) -> Vec<u8> {
    let mut v = vec![3];
    v.extend_from_slice(&player.to_le_bytes());
    v.extend_from_slice(&life.to_le_bytes());
    v.extend_from_slice(&x.to_le_bytes());
    v.extend_from_slice(&y.to_le_bytes());
    v.push(facing);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_each_kind() {
        assert_eq!(decode(&[1, 7, 0, 0, 0]), Ok(Input::Join { player: 7 }));
        assert_eq!(decode(&[2, 7, 0, 0, 0]), Ok(Input::Leave { player: 7 }));
        let mut pos = vec![3, 1, 0, 0, 0, 2, 0];
        pos.extend_from_slice(&(-5i32).to_le_bytes());
        pos.extend_from_slice(&9i32.to_le_bytes());
        pos.push(1);
        assert_eq!(decode(&pos), Ok(Input::Pos { player: 1, life: 2, x: -5, y: 9, facing: 1 }));
        assert_eq!(
            decode(&[4, 1, 0, 0, 0, 3, 0x34, 0x12, 9, 0]),
            Ok(Input::Cast { player: 1, spell: 3, angle: 0x1234, cast_seq: 9 })
        );
        assert_eq!(
            decode(&encode_paint(2, 4, -1, 2, 300, 4, 3)),
            Ok(Input::Paint { player: 2, mat: 4, x0: -1, y0: 2, x1: 300, y1: 4, radius: 3 })
        );
    }

    #[test]
    fn rejects_malformed() {
        assert!(decode(&[]).is_err());
        assert!(decode(&[9, 0, 0, 0, 0]).is_err());
        assert!(decode(&[1, 0, 0, 0]).is_err());
        assert!(decode(&[5, 0, 0, 0, 0, 4]).is_err());
        assert!(decode(&[1, 0, 0, 0, 0, 0]).is_err());
    }
}
