/*
        JSNascom: A Nascom 2 emulator in JavaScript
        Copyright (C) 2011 Tommy Thorn

        Contact details: <tommy . thorn at gmail dot com>

        partly based on JSSpeccy: Spectrum architecture implementation
        for JSSpeccy, a ZX Spectrum emulator in Javascript

        This program is free software: you can redistribute it and/or modify
        it under the terms of the GNU General Public License as published by
        the Free Software Foundation, either version 3 of the License, or
        (at your option) any later version.

        This program is distributed in the hope that it will be useful,
        but WITHOUT ANY WARRANTY; without even the implied warranty of
        MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
        GNU General Public License for more details.

        You should have received a copy of the GNU General Public License
        along with this program.  If not, see <http://www.gnu.org/licenses/>.


    A Nascom consists of:

    - a Z80 CPU,
    - an UART,
    - a bitmapped keyboard,
    - memory:
        0000 - 07ff  2 KB ROM monitor,
        0800 - 0bff  1 KB screen memory,
        0c00 - 0fff  1 KB workspace
        1000 - dfff       memory
        e000 - ffff  8 KB of MS Basic

  With the Z80 emulator in place the first thing to get working is the
  screen memory.  The "correct" way to simulate screen memory is to
  trap upon writes, but that would be slow.  We do it any just to get
  started.

*/

var phys_mem;
var memory;
var phys_mem16;
var phys_mem32;

var canvas;
var ctx;
var imageData;
var imageDataData;
var keyStates = [];
var imageDataShadow = []; /* clone of imageDataData; - used to skip writing pixels to canvas if there's no change */

var hasImageData;
var needDrawImage = (navigator.userAgent.indexOf('Firefox/2') != -1);



var keyp = 0;
var port0 = 0;
var keym = [0, 0, 0, 0, 0, 0, 0, 0, 0];

var replay_active = true;
var replay_line = " HELLO THERE\n"
var replay_p   = 0;
var replay_down = true;

function advance_replay() {
    sim_key(replay_line[replay_p], replay_down);
    if (replay_down == false) {
        ++replay_p;
        if (replay_line.length == replay_p)
            replay_active = false;
    }
    replay_down = !replay_down;
}

function form_enter() {
    replay_active = true;
    replay_p = 0;
    replay_down = true;
    replay_line = "(did not parse)\n";

    var t1 = document.getElementById('t1');
    replay_line = t1.value + "\n";

    var l = "";
    // Swap case (clearly I'm a JS n00b)
    /*
    for (var i = 0; i < replay_line.length; ++i) {
        if ('A' <= replay_line[i] && replay_line[i] <= 'Z')
            l += replay_line[i].toLowerCase();
        else
            l += replay_line[i].toUpperCase();
    }
    replay_line = l;
    */

    t1.value = "";
}

var nmi_pending = false;

function click(evt) {
    console.log("'click'");
//    event_next_event = 0;
//    nmi_pending = true;
}

function nascom_unload() {
    var serialized = "";
    for (i = 0; i < 16384; ++i)
        serialized += phys_mem32[i] + ",";
    localStorage.setItem("memory", serialized);
}

function nascom_init() {
    var i;

    if (!'localStorage' in window || window['localStorage'] === null)
        alert("Need a less broken browser");

    if (1 /* not on iPhone */) {
        document.onkeydown  = keyDown;
        document.onkeyup    = keyUp;
        document.onkeypress = keyPress;
    }

    document.addEventListener('click', click, false);

//    document.addEventListener('touchstart', touchStart, false);
//    document.addEventListener('touchend', touchEnd, false);


    z80_init();

    var ea = 64 * 1024;
    phys_mem = new ArrayBuffer(ea);
    memory = new Uint8Array(this.phys_mem, 0, ea);
    phys_mem16 = new Uint16Array(this.phys_mem, 0, ea / 2);
    phys_mem32 = new Int32Array(this.phys_mem, 0, ea / 4);

    // Memory
    for (i = 0x800; i < 0xE000; i++)
        memory[i] = 0;

    var val = localStorage.getItem("memory");

    if (val !== null) {
        var aval = val.split(",");
        for (i = 0; i < 16384; ++i)
            phys_mem32[i] = parseInt(aval[i]);
    }

    // NASSYS-3
    for (i = 0; i < 0x800; i++)
        memory[i] = rom_monitor.charCodeAt(i);

    // ROM Basic
    for (i = 0xE000; i < 0x10000; i++)
        memory[i] = rom_basic.charCodeAt(i - 0xE000);

    canvas = document.getElementById('screen');
    ctx = canvas.getContext('2d');

    paintScreen();

    run();
}

var kbd_translation = [
// 7:NC for all rows
/* 0 */  "````````", // 6:NC 5:Ctrl 4:Shift 3:Ctrl 2:NC 1:NC 0:NC
/* 1 */  "``txf5bh",
/* 2 */  "``yzd6nj",
/* 3 */  "``use7mk",
/* 4 */  "``iaw8,l",
/* 5 */  "``oq39.;", // 6:Graph?
/* 6 */  "`[p120/:",
/* 7 */  "`]r c4vg",
/* 8 */  "`\r```-\n\007"
];

var kbd_translation_shifted = [
// 7:NC for all rows
/* 0 */  "``@`````", // 6:NC 5:Ctrl 4:Shift 3:Ctrl 2:NC 1:NC 0:NC
/* 1 */  "``TXF%BH",
/* 2 */  "``YZD&NJ",
/* 3 */  "``USE'MK",
/* 4 */  "``IAW(,L",
/* 5 */  "``OQ#)>+", // 6:graph?
/* 6 */  "`\\P!\"^?*",
/* 7 */  "`_R`C$VG",
/* 8 */  "`````=``"
];

var gr_row = 5;
var gr_col = 6;

function sim_key(ch, down) {
    var row = -1, bit, shifted = 0;

    for (var i = 0; i < 9 && row == -1; ++i)
        for (bit = 0; bit < 8; ++bit)
            if (kbd_translation[i][7-bit] == ch) {
                row = i;
                break;
            }

    for (var i = 0; i < 9 && row == -1; ++i)
        for (bit = 0; bit < 8; ++bit)
            if (kbd_translation_shifted[i][7-bit] == ch) {
                row = i;
                shifted = 1;
                break;
            }

    shifted = 0;

    if (row != -1) {
        //console.log("key "+(down?"down":"up")+" at row "+row+" col "+bit);
        if (down) {
            keym[row] |= 1 << bit;
            keym[0] |= shifted << 4;
        }
        else {
            keym[row] &= ~(1 << bit);
            keym[0] &= ~(shifted << 4);
        }
    } else if (down)
        console.log("Sorry, couldn't find translation for "+ch);
}

function registerKey(evt, down) {
    var keyNum = evt.keyCode;
    var ch;
    var row = -1, bit, i;


    /* Sigh, keyboard handing in JavaScript is a bloddy mess this is
       based on
       http://www.cambiaresearch.com/c4/702b8cd1-e5b0-42e6-83ac-25f0306e3e25/javascript-char-codes-key-codes.aspx
       and has only so far been tested on Mac with Chrome. */

    switch (keyNum) {
    case 17: row = 0, bit = 3; break; // control (5 works too)
    case 16: row = 0, bit = 4; break; // shift
//  case 220:row = 0, bit = 5; break; // control (@, guess)
    case 38: row = 1, bit = 6; break; // up arrow
    case 37: row = 2, bit = 6; break; // left arrow
    case 40: row = 3, bit = 6; break; // down arrow
    case 39: row = 4, bit = 6; break; // right arrow
    case 18: row = 5, bit = 6; break; // graph (guess)
    case  8: row = 8, bit = 0; break; // backspace
    case 13: row = 8, bit = 1; break; // enter
    case 91: return; // Command/Apple
    case 186: ch = ';'; break;
    case 187: ch = '='; break;
    case 188: ch = ','; break;
    case 190: ch = '.'; break;
    case 191: ch = '/'; break;
    case 219: ch = '['; break;
    case 220: ch = '\r'; break;
    case 221: ch = ']'; break;
    case 222: ch = ':'; break; // Not ideal, pressing ' but getting :
    default:
        console.log("registerKey " + keyNum + "/" + ch + "/" +
                    evt.charCode + "/" +
                    String.fromCharCode(evt.charCode) + "/" +
                    event.char + "/" +
                    evt.keyIdentifier);
    }

    if (row == -1) {
        if (ch == undefined)
            ch = String.fromCharCode(keyNum)/*.toUpperCase()*/;

        sim_key(ch, down);
    } else if (down)
        keym[row] |= 1 << bit;
    else
        keym[row] &= ~(1 << bit);
}

function keyDown(evt) {
    registerKey(evt, true)
    if (!evt.metaKey) return false;
}

function keyUp(evt) {
//  console.log("keyDown "+evt);
    registerKey(evt, false);
    if (!evt.metaKey) return false;
}

function keyPress(evt) {
    if (!evt.metaKey) return false;
}

/*

var touch_row = 4;
var touch_col = 4;

function touchStart(evt) {
    evt.preventDefault();
    var touch = evt.touches[0];
    var x = touch.pageX;
    var y = touch.pageY;

    touch_row = Math.floor(x*9/384);
    touch_col = Math.floor(y*7/300);

    console.log("Touch x:" + touch.pageX + ", y:" + touch.pageY + "->" +touch_row+" "+touch_col+
               " "+kbd_translation[touch_row][touch_col]);

    keym[touch_row] |= 1 << touch_col;
}

function touchEnd(evt) {
    evt.preventDefault();
    var touch = evt.touches[0];

    keym[touch_row] &= ~(1 << touch_col);
}
*/

var paintCountdown = 0;

function frame() {
    event_next_event = 69888;
    event_next_event = 129888;
    tstates = 0;

    z80_do_opcodes();

    if (nmi_pending) {
        nmi_pending = false;
        z80_nmi();
    }

/*
    if (paintCountdown-- == 0) {
        paintScreen();
        paintCountdown = 20;
    }
*/

    z80_interrupt();
}

function run() {

    // if (!running) return;
    frame();

    setTimeout(run, 20);
}

function contend_memory(addr) {
    return 0; /* TODO: implement */
}
function contend_port(addr) {
    return 0; /* TODO: implement */
}
function readbyte(addr) {
    return readbyte_internal(addr);
}
function readbyte_internal(addr) {
    return memory[addr];
}
function readport(port) {
    port &= 255;

    switch (port) {
    case 0:
        /* KBD */
        /* printf("[%d]", keyp); */
        return ~keym[keyp];
    case 2:
        /* Status port on the UART */
        return 0;
    default:
        console.log("readport "+port);
        return 0;
    }
}

function writeport(port, value) {
    port &= 255;

    if (port != 0 || (value & ~3) != 0)
        console.log("writeport "+port+","+value);

    if (port == 0) {
        /* KBD */
        var down_trans = port0 & ~value;
        var up_trans = ~port0 & value;
        port0 = value;

        if (1 & down_trans)
            keyp++;
        if (2 & down_trans) {
            keyp = 0;
            if (replay_active)
                advance_replay();
        }
        // bit 2 and 5 also go to the keyboard but does what?
        if (8 & up_trans) {
        // console.log("Single-step triggered");
            /* The logic implemented by IC14 & IC15
               appears to delay the NMI by counting
               110
               010
               100
               000
               111 -> NMI
               so four cycles? (experiments suggest using 25)

               20 1000
               22 1000
               23 1000
               24 1000
               25 1001
               30 1002
               40 1004

               This should probably not use tstates, but this will
               work for NAS-SYS 3
            */
            nmi_pending = true;
            event_next_event = tstates + 25;
        }
    }
}

function writebyte(addr, val) {
    return writebyte_internal(addr, val)
}

function writebyte_internal(addr, val) {
    if (addr < 0x800 || 0xE000 <= addr)
        return;

    var col = addr & 63;

    if (addr < 0xC00 && 10 <= col && col < 58) {
        // Visible Screen write
        var oldByte = memory[addr];
        memory[addr] = val;
        if (val != oldByte)
            drawScreenByte(addr, val);
    } else
        memory[addr] = val;
}

var char_height = 15; // PAL=12 , NTSC = 14 ?? (I think that's should be 13/15)
function drawScreenByte(addr, val) {
    var x = (addr & 63) - 10;
    var y = ((addr >> 6) + 1) & 15;

    if (x < 0 || 48 <= x || y < 0 || 16 <= y || val < 0 || 255 < val)
        console.log("x,y,val "+x+" "+y+" "+val);

    if (ctx != undefined && rom_font != undefined &&
        val != undefined) {
        ctx.drawImage(rom_font,
                  0, 16*val,            // sx,sy
                  8, char_height,       // sWidth, sHeight
                  x*8,y*char_height,    // dx,dy
                  8, char_height);      // dWidth, dHeight
    } else
        console.log("Oh no");
}

function paintScreen() {
    for (var addr = 0x800; addr < 0xC00; ++addr) {
        col = addr & 63;
        if (10 <= col && col < 58)
            drawScreenByte(addr, memory[addr]);
    }
}
