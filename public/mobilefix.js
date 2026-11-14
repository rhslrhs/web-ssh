'use strict';
// 크롬 "데스크톱 사이트"가 켜져 있어도(같은 상위 도메인의 다른 사이트에서 켠 설정이 따라오는 경우 등)
// 폰에서는 모바일 화면으로 보이게 한다. 데스크톱 모드가 아니면 아무것도 하지 않는다.
//   1단계: viewport 를 실제 화면 폭으로 다시 지정
//   2단계: 그래도 넓은 화면(약 980px)으로 그려지면 페이지 전체를 확대(zoom)해 화면 폭에 맞춘다
(function () {
  var html = document.documentElement;
  if (!window.matchMedia || !matchMedia('(pointer: coarse)').matches) return; // PC 는 그대로
  var dw = function () { return Math.round(screen.width) || 0; };
  var wide = function () { return dw() > 0 && html.clientWidth > dw() * 1.2; };
  if (!wide()) return;

  var meta = document.querySelector('meta[name=viewport]');
  if (meta) meta.setAttribute('content', 'width=' + dw() + ', initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content');

  // 확대(zoom)된 페이지 안에서 100vw·100dvh 는 배율만큼 커져 화면 밖으로 넘친다 → 실제 보이는 크기를 변수로 준다
  function sizeVars(z) {
    var vv = window.visualViewport;
    var h = vv ? vv.height : window.innerHeight;
    html.style.setProperty('--vw100', (html.clientWidth / z) + 'px');
    html.style.setProperty('--vh100', (h / z) + 'px');
  }
  function fallback() {
    if (!wide()) {
      html.style.zoom = ''; html.style.removeProperty('--vw100'); html.style.removeProperty('--vh100');
      html.classList.remove('force-mobile', 'force-narrow'); window.uiZoom = 1; return;
    }
    var z = html.clientWidth / dw();
    html.style.zoom = String(z);
    sizeVars(z);
    html.classList.add('force-mobile');
    html.classList.toggle('force-narrow', dw() <= 480); // @media (max-width: 480px) 대신
    window.uiZoom = z;
  }
  // viewport 변경이 반영될 시간을 준 뒤 확인
  requestAnimationFrame(function () { requestAnimationFrame(fallback); });
  window.addEventListener('orientationchange', function () { setTimeout(fallback, 300); });
  window.addEventListener('resize', function () { if (html.classList.contains('force-mobile') || wide()) fallback(); });
  // 키보드가 열리고 닫힐 때 보이는 높이가 바뀐다
  if (window.visualViewport) visualViewport.addEventListener('resize', function () { if (window.uiZoom > 1) sizeVars(window.uiZoom); });
})();
