/*
This uses the beaker.bookmarks API, which is exposed by webview-preload to all sites loaded over the beaker: protocol
*/

import * as yo from 'yo-yo'

const KEYCODE_ENTER = 13
const KEYCODE_ESC = 27

// globals
// =

// bookmarks, cached in memory
var bookmarks = []

// main rendered element
var bookmarksTBody

// anything currently being edited?
var isEditing = false


// exported API
// =

export function setup () {
  // fetch bookmarks
  beaker.bookmarks.list((err, bs) => {
    bookmarks = bs || []

    // sort by title
    bookmarks.sort((a, b) => a.title.localeCompare(b.title))

    // do initial render
    bookmarksTBody = render()
    document.querySelector('.bookmarks').appendChild(bookmarksTBody)
  })

  // register global handlers
  document.addEventListener('click', onClickAnywhere)
}

// rendering
// =

function render () {
  return yo`<tbody>
    ${bookmarks.map((b, i) => {

      // render address column
      var urlCol
      if (isEditing == i+':url')
        urlCol = yo`<td><input class="bookmark-url-input" value=${b.url} onclick=${stopEvent} onkeyup=${onKeyupInput.bind(window, i, 'url')}></td>`
      else
        urlCol = yo`<td onclick=${onClickColumn.bind(window, i, 'url')}>${b.url}</td>`

      // render row
      return yo`<tr>
        <td onclick=${onClickColumn.bind(window, i, 'title')}>
          <a href=${b.url} title=${b.title}><span class="icon icon-window"></span> ${b.title}</a>
        </td>
        ${urlCol}
        <td class="actions">
          <span class="icon icon-cancel-squared" onclick=${onClickDelete.bind(window, i)} title="Delete bookmark"></span>
        </td>
      </tr>`
    })}
  </tbody>`
}

// event handlers
// =

function onClickColumn (i, key, e) {
  // do nothing if they clicked on the link
  if (e.target.tagName == 'A')
    return
  e.preventDefault()
  e.stopPropagation()

  // re-render
  isEditing = i+':'+key
  yo.update(bookmarksTBody, render())

  // focus and select all text in the new input
  var inputEl = bookmarksTBody.querySelector('tr:nth-child('+(i+1)+') .bookmark-'+key+'-input')
  if (inputEl) {
    inputEl.focus()
    inputEl.select()
  }
}

function onClickDelete (i) {
  // remove
  var b = bookmarks[i]
  bookmarks.splice(i, 1)
  beaker.bookmarks.remove(b.url)

  // render
  yo.update(bookmarksTBody, render())
}

function onKeyupInput (i, key, e) {
  // on enter or escape
  if (e.keyCode == KEYCODE_ENTER || e.keyCode == KEYCODE_ESC) {
    // on enter, save kv change
    if (e.keyCode == KEYCODE_ENTER) {
      var b = bookmarks[i]

      // update db
      if (key == 'url')
        beaker.bookmarks.changeUrl(b.url, e.target.value)
      if (key == 'title')
        beaker.bookmarks.changeTitle(b.url, e.target.value)        

      // update in memory
      b[key] = e.target.value
    }

    // stop editing
    isEditing = false
    yo.update(bookmarksTBody, render())
  }
}

function stopEvent (e) {
  // stop the event, so that onClickAnywhere isnt called
  e.preventDefault()
  e.stopPropagation()  
}

function onClickAnywhere (e) {
  // stop any editing
  // (prevented by stopEvent)
  isEditing = false
  yo.update(bookmarksTBody, render())
}