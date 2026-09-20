package app.fareloch;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int CAMERA_PERMISSION_REQUEST = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Android 15 (SDK 35) forces edge-to-edge, so the WebView draws behind the
        // status bar and gesture-nav bar. On Android, CSS env(safe-area-inset-*)
        // only reports display cutouts, not the system bars, so the web layer has no
        // pure-CSS way to learn the status-bar height. Feed the real window insets in
        // as --safe-area-inset-* CSS variables, which styles.css already consumes.
        final WebView webView = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout());
            float density = getResources().getDisplayMetrics().density;
            String js = String.format(
                    "(function(){var s=document.documentElement.style;" +
                    "s.setProperty('--safe-area-inset-top','%dpx');" +
                    "s.setProperty('--safe-area-inset-bottom','%dpx');" +
                    "s.setProperty('--safe-area-inset-left','%dpx');" +
                    "s.setProperty('--safe-area-inset-right','%dpx');})();",
                    Math.round(bars.top / density),
                    Math.round(bars.bottom / density),
                    Math.round(bars.left / density),
                    Math.round(bars.right / density));
            webView.evaluateJavascript(js, null);
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(webView);

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST);
        }
    }
}
